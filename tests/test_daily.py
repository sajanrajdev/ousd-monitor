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
case "$1" in
  run) [ -f "$FAKES/run-fails" ] && exit 1; exit 0 ;;
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
[ -f "$FAKES/deploy-fails" ] && exit 1
echo "https://ousd-monitor-abc123.vercel.app"
"""


def _executable(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "scripts").mkdir()
    shutil.copy(REPO / "scripts" / "daily.sh", tmp_path / "scripts" / "daily.sh")
    fakes = tmp_path / "fakes"
    (fakes / "bin").mkdir(parents=True)
    _executable(fakes / "bin" / "make", FAKE_MAKE)
    _executable(fakes / "bin" / "vercel", FAKE_VERCEL)
    return tmp_path


def daily(root: Path, **extra: str) -> subprocess.CompletedProcess:
    fakes = root / "fakes"
    env = {
        "PATH": f"{fakes / 'bin'}:/usr/bin:/bin",
        "HOME": str(root),
        "UNLISTED": "x",
        "OUSD_ACK_WARNING_KEYS": "ethereum:circulating_supply",
        **RPC,
        **VERCEL,
        **extra,
    }
    env = {key: value for key, value in env.items() if value != "<unset>"}
    return subprocess.run(
        [BASH, str(root / "scripts" / "daily.sh")],
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
    assert "vercel deploy exited non-zero" in result.stdout
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
