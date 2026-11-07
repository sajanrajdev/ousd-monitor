"""scripts/daily.sh, run on an isolated copy with stand-ins for make and vercel on PATH."""

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
BASH = shutil.which("bash") or "/bin/bash"
RPC = {
    "BASE_RPC_URL": "https://base.provider.invalid/v2/rpc-secret-base-111",
    "SOLANA_RPC_URL": "https://solana.provider.invalid/?api-key=rpc-secret-sol-222",
    "ETHEREUM_RPC_URL": "https://eth.provider.invalid/rpc-secret-eth-333",
}
VERCEL = {
    "VERCEL_TOKEN": "vercel-secret-token-444",
    "VERCEL_ORG_ID": "team_org555",
    "VERCEL_PROJECT_ID": "prj_project666",
}
SECRETS = [*RPC.values(), VERCEL["VERCEL_TOKEN"]]

# Each stand-in writes the names (never values) it was given, and records its arguments.
FAKE_MAKE = """#!/bin/sh
FAKES="$(pwd)/fakes"
env | cut -d= -f1 | sort > "$FAKES/make-$1.env"
printf '%s\\n' "$*" >> "$FAKES/calls"
[ -n "${OUSD_HEARTBEAT_URL+x}" ] && [ -z "$OUSD_HEARTBEAT_URL" ] && touch "$FAKES/no-heartbeat-$1"
case "$1" in
  run)
    if [ -f "$FAKES/run-fails-alerted" ]; then
      mkdir -p data/alerts && echo '{}' > data/alerts/run-1.json
      exit 1
    fi
    [ -f "$FAKES/run-fails" ] && exit 1
    [ -f "$FAKES/run-publishes-nothing" ] && exit 0
    n=$(ls data/published | wc -l | tr -d ' ')
    mkdir -p "data/published/v$n" && ln -sfn "v$n" data/published/latest
    exit 0
    ;;
  web-release)
    [ -f "$FAKES/release-fails" ] && exit 1
    mkdir -p web/.release/v1/sub
    echo '<html></html>' > web/.release/v1/index.html
    echo 'x' > web/.release/v1/sub/a.txt
    ln -sfn v1 web/.release/latest
    ;;
esac
"""
FAKE_VERCEL = """#!/bin/sh
FAKES="$(pwd)/fakes"
env | cut -d= -f1 | sort > "$FAKES/vercel.env"
printf '%s\\n' "vercel $*" >> "$FAKES/calls"
for arg in "$@"; do
  case "$arg" in --cwd) next=1 ;; *) [ -n "$next" ] && cwd="$arg"; next= ;; esac
done
cp -R "$cwd/.vercel" "$FAKES/uploaded"
if [ -f "$FAKES/deploy-fails" ]; then
  echo '{"status":"error","reason":"deploy_failed","message":"Upload refused"}'
  exit 1
fi
target=preview
[ -f "$FAKES/deploy-production" ] && target=production
printf '{"status":"ok","deployment":{"url":"https://ousd-monitor-abc123.vercel.app",'
printf '"target":"%s","readyState":"READY"},"message":"ready"}\n' "$target"
"""


# Stands in for `uv run --locked ousd alert|heartbeat`, apart from the make and vercel calls.
FAKE_UV = """#!/bin/sh
FAKES="$(pwd)/fakes"
env | cut -d= -f1 | sort > "$FAKES/uv.env"
printf '%s\\n' "$*" >> "$FAKES/uv-calls"
case "$*" in *heartbeat*) [ -f "$FAKES/heartbeat-fails" ] && exit 1 ;; esac
exit 0
"""
WEBHOOK = "https://hooks.example.invalid/services/hook-secret-777"
HEARTBEAT = "https://hc-ping.example.invalid/ping-secret-888"


def _executable(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


@pytest.fixture(params=sorted({BASH, *(["/bin/bash"] if Path("/bin/bash").exists() else [])}))
def shell(request) -> str:
    return request.param


@pytest.fixture
def root(tmp_path: Path, shell: str) -> Path:
    (tmp_path / "scripts").mkdir()
    for name in ("daily.sh", "deploy-result.mjs"):
        shutil.copy(REPO / "scripts" / name, tmp_path / "scripts" / name)
    (tmp_path / "data" / "published").mkdir(parents=True)
    (tmp_path / "shell").write_text(shell)
    fakes = tmp_path / "fakes"
    (fakes / "bin").mkdir(parents=True)
    _executable(fakes / "bin" / "make", FAKE_MAKE)
    _executable(fakes / "bin" / "vercel", FAKE_VERCEL)
    _executable(fakes / "bin" / "uv", FAKE_UV)
    return tmp_path


def daily(root: Path, **extra: str) -> subprocess.CompletedProcess:
    fakes = root / "fakes"
    node_dir = str(Path(shutil.which("node") or "/usr/bin/node").parent)
    env = {
        "PATH": f"{fakes / 'bin'}:{node_dir}:/usr/bin:/bin",
        "HOME": str(root),
        "UNLISTED": "x",
        "OUSD_ACK_WARNING_KEYS": "ethereum:circulating_supply",
        **RPC,
        **VERCEL,
        **extra,
    }
    env = {key: value for key, value in env.items() if value != "<unset>"}
    return subprocess.run(
        [(root / "shell").read_text(), str(root / "scripts" / "daily.sh")],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def names(root: Path, step: str) -> set[str]:
    return set((root / "fakes" / f"{step}.env").read_text().split())


def calls(root: Path) -> list[str]:
    path = root / "fakes" / "calls"
    return path.read_text().splitlines() if path.exists() else []


def assert_no_secret_in(result: subprocess.CompletedProcess) -> None:
    for secret in SECRETS:
        assert secret not in result.stdout + result.stderr


def test_runs_pipeline_release_and_a_preview_deploy(root):
    result = daily(root)
    assert result.returncode == 0, result.stdout + result.stderr
    assert calls(root)[:2] == ["run", "web-release"]
    deploy = calls(root)[2]
    assert deploy.startswith("vercel deploy --prebuilt --cwd ")
    assert "--prod" not in deploy
    assert "--token" not in deploy
    assert "Preview deployed: https://ousd-monitor-abc123.vercel.app" in result.stdout
    assert_no_secret_in(result)


def test_each_step_sees_only_its_variables(root):
    assert daily(root).returncode == 0
    pipeline = names(root, "make-run")
    assert set(RPC) <= pipeline
    assert not set(VERCEL) & pipeline
    release = names(root, "make-web-release")
    assert not set(RPC) & release
    assert not set(VERCEL) & release
    assert "OUSD_ACK_WARNING_KEYS" in release
    assert "UNLISTED" not in release
    deploy = names(root, "vercel")
    assert set(VERCEL) <= deploy
    assert not set(RPC) & deploy
    assert "UNLISTED" not in deploy


def test_no_value_reaches_a_command_line(root):
    assert daily(root).returncode == 0
    for line in calls(root):
        for value in [*RPC.values(), *VERCEL.values()]:
            assert value not in line


def test_uploads_only_the_verified_release_as_build_output(root):
    assert daily(root).returncode == 0
    uploaded = root / "fakes" / "uploaded" / "output"
    assert (uploaded / "config.json").read_text().strip() == '{"version": 3}'
    assert (uploaded / "static" / "index.html").is_file()
    assert (uploaded / "static" / "sub" / "a.txt").is_file()
    assert not (uploaded / "static").is_symlink()
    assert sorted(p.name for p in uploaded.iterdir()) == ["config.json", "static"]


def test_a_failed_run_releases_and_deploys_nothing(root):
    (root / "fakes" / "run-fails").touch()
    result = daily(root)
    assert result.returncode != 0
    assert calls(root) == ["run"]
    assert "nothing is released or deployed" in result.stdout


def test_a_refused_release_deploys_nothing(root):
    (root / "fakes" / "release-fails").touch()
    result = daily(root)
    assert result.returncode != 0
    assert calls(root) == ["run", "web-release"]


def test_a_failed_deploy_exits_non_zero(root):
    (root / "fakes" / "deploy-fails").touch()
    result = daily(root)
    assert result.returncode != 0
    assert "did not make a preview" in result.stdout
    assert "deploy_failed: Upload refused" in result.stderr
    assert_no_secret_in(result)


def test_a_deploy_that_lands_in_production_fails_loudly(root):
    (root / "fakes" / "deploy-production").touch()
    result = daily(root)
    assert result.returncode != 0
    assert "went to PRODUCTION" in result.stderr
    assert "Preview deployed" not in result.stdout


def test_a_missing_token_on_railway_fails(root):
    result = daily(root, VERCEL_TOKEN="<unset>", RAILWAY_ENVIRONMENT_ID="env-1")
    assert result.returncode != 0
    assert "VERCEL_TOKEN is not set on Railway" in result.stdout
    assert calls(root) == ["run", "web-release"]


def test_explicit_deploy_off_works_on_railway(root):
    result = daily(root, OUSD_DEPLOY="0", RAILWAY_ENVIRONMENT_ID="env-1")
    assert result.returncode == 0
    assert "Deploy skipped: OUSD_DEPLOY=0" in result.stdout


@pytest.mark.parametrize("value", ["false", "no", "off", "yes"])
def test_an_unclear_deploy_switch_refuses_before_running(root, value):
    result = daily(root, OUSD_DEPLOY=value)
    assert result.returncode != 0
    assert "OUSD_DEPLOY must be 0 or 1" in result.stdout
    assert calls(root) == []


@pytest.mark.parametrize("name", ["OUSD_PUBLISHED_DIR", "OUSD_DATASET_DIR"])
def test_a_moved_dataset_path_refuses_before_running(root, name):
    result = daily(root, **{name: "/elsewhere"})
    assert result.returncode != 0
    assert f"{name} is set" in result.stdout
    assert calls(root) == []


def test_a_run_that_publishes_nothing_new_releases_nothing(root):
    (root / "fakes" / "run-publishes-nothing").touch()
    result = daily(root)
    assert result.returncode != 0
    assert "published no new dataset" in result.stdout
    assert calls(root) == ["run"]


def test_a_non_identifier_variable_stops_the_allowlisted_steps(root):
    result = daily(root, **{"BAD-NAME": "rpc-secret-sol-222"})
    assert result.returncode != 0
    assert "isn't an identifier" in result.stderr
    assert calls(root) == ["run"]
    assert_no_secret_in(result)


@pytest.mark.parametrize(
    ("extra", "reason"),
    [({"OUSD_DEPLOY": "0"}, "OUSD_DEPLOY=0"), ({"VERCEL_TOKEN": "<unset>"}, "VERCEL_TOKEN")],
)
def test_the_deploy_switch_builds_but_does_not_deploy(root, extra, reason):
    result = daily(root, **extra)
    assert result.returncode == 0, result.stdout + result.stderr
    assert calls(root) == ["run", "web-release"]
    assert f"Deploy skipped: {reason}" in result.stdout


@pytest.mark.parametrize("missing", ["VERCEL_ORG_ID", "VERCEL_PROJECT_ID"])
def test_a_token_without_the_project_refuses(root, missing):
    result = daily(root, **{missing: "<unset>"})
    assert result.returncode != 0
    assert calls(root) == ["run", "web-release"]
    assert f"{missing} is not set" in result.stdout


def test_the_commit_comes_from_the_deploy(root):
    fake = root / "fakes" / "bin" / "make"
    fake.write_text(
        fake.read_text().replace("case", 'echo "$OUSD_GIT_COMMIT" > "$FAKES/commit-$1"\ncase', 1)
    )
    assert daily(root, RAILWAY_GIT_COMMIT_SHA="abcdef0123456789").returncode == 0
    assert (root / "fakes" / "commit-run").read_text().strip() == "abcdef0123456789"
    # Railway's commit wins over a value set by hand, which could be stale.
    assert (
        daily(
            root, RAILWAY_GIT_COMMIT_SHA="abcdef0123456789", OUSD_GIT_COMMIT="fedcba987654"
        ).returncode
        == 0
    )
    assert (root / "fakes" / "commit-run").read_text().strip() == "abcdef0123456789"
    # Off Railway, as in a local run, the value set by hand is used.
    assert daily(root, OUSD_GIT_COMMIT="fedcba987654").returncode == 0
    assert (root / "fakes" / "commit-run").read_text().strip() == "fedcba987654"


def test_the_script_is_executable():
    assert os.access(REPO / "scripts" / "daily.sh", os.X_OK)


def uv_calls(root: Path) -> list[str]:
    path = root / "fakes" / "uv-calls"
    return path.read_text().splitlines() if path.exists() else []


HEARTBEAT_CALL = "run --locked ousd heartbeat"


def alert_call(step: str, reason: str) -> str:
    return f"run --locked ousd alert --step {step} --reason {reason}"


def test_only_a_deployed_run_pings_the_heartbeat_and_make_run_never_does(root):
    result = daily(root, OUSD_HEARTBEAT_URL=HEARTBEAT, OUSD_ALERT_WEBHOOK_URL=WEBHOOK)
    assert result.returncode == 0, result.stdout + result.stderr
    assert uv_calls(root) == [HEARTBEAT_CALL]
    # Blank for the pipeline, which would otherwise ping before the release and deploy.
    assert (root / "fakes" / "no-heartbeat-run").exists()
    assert not set(VERCEL) & names(root, "uv")
    for line in calls(root) + uv_calls(root):
        assert HEARTBEAT not in line
        assert WEBHOOK not in line


def test_a_run_built_without_deploying_is_still_a_success(root):
    assert daily(root, OUSD_DEPLOY="0").returncode == 0
    assert uv_calls(root) == [HEARTBEAT_CALL]


def test_an_undelivered_heartbeat_does_not_fail_a_deployed_run(root):
    (root / "fakes" / "heartbeat-fails").touch()
    result = daily(root)
    assert result.returncode == 0
    assert "The heartbeat was not delivered." in result.stdout


@pytest.mark.parametrize(
    ("fake", "step", "reason"),
    [
        ("release-fails", "release", "make web-release refused or failed, so nothing is deployed."),
        ("deploy-fails", "deploy", "vercel deploy did not make a preview (see the run's log)."),
        (
            "run-publishes-nothing",
            "pipeline",
            "make run passed but published no new dataset, so nothing is released or deployed.",
        ),
        ("run-fails", "pipeline", "make run exited non-zero, so nothing is released or deployed."),
    ],
)
def test_a_failure_the_pipeline_did_not_alert_on_raises_one_and_never_pings(
    root, fake, step, reason
):
    (root / "fakes" / fake).touch()
    result = daily(root)
    assert result.returncode != 0
    assert uv_calls(root) == [alert_call(step, reason)]


def test_a_failed_run_that_alerted_itself_is_not_alerted_twice(root):
    (root / "fakes" / "run-fails-alerted").touch()
    result = daily(root)
    assert result.returncode != 0
    assert uv_calls(root) == []


def test_a_bad_setting_alerts_before_anything_runs(root):
    result = daily(root, OUSD_DEPLOY="maybe")
    assert result.returncode != 0
    assert uv_calls(root) == [alert_call("config", "OUSD_DEPLOY must be 0 or 1.")]
    assert calls(root) == []
