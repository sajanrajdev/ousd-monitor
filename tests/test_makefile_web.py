"""The Makefile's site steps, run on an isolated copy so nothing here recurses into `make check`."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
MAKE = shutil.which("make") or "make"
PACKAGE_JSON = """{
  "packageManager": "pnpm@1.2.3",
  "engines": {
    "node": "^22.12 || ^24"
  }
}
"""
INSTALL_MESSAGE = "Install Node ^22.12 || ^24"
WEB_COMMAND = ("npx", "pnpm", "node ", "web/")
PYTHON_STEPS = {
    "check": ("ruff check", "mypy", "pytest"),
    "lint": ("ruff check",),
    "types": ("mypy",),
    "test": ("pytest",),
    "build": ("uv build",),
}


@pytest.fixture
def copy(tmp_path: Path) -> Path:
    shutil.copy(REPO / "Makefile", tmp_path / "Makefile")
    return tmp_path


def add_site(copy: Path) -> None:
    (copy / "web").mkdir()
    (copy / "web" / "package.json").write_text(PACKAGE_JSON)


def make(copy: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [MAKE, *args], cwd=copy, env=env, capture_output=True, text=True, check=False
    )


def tools_only(copy: Path, *passing: str, failing: tuple[str, ...] = ()) -> dict[str, str]:
    """A PATH with sed and stubs, so node and npx are missing unless a stub names them."""
    bin_dir = copy / "bin"
    bin_dir.mkdir()
    sed = shutil.which("sed")
    assert sed
    (bin_dir / "sed").symlink_to(sed)
    for stub, status in [(name, 0) for name in passing] + [(name, 1) for name in failing]:
        (bin_dir / stub).write_text(f"#!/bin/sh\nexit {status}\n")
        (bin_dir / stub).chmod(0o755)
    return {**os.environ, "PATH": str(bin_dir)}


@pytest.mark.parametrize("target", sorted(PYTHON_STEPS))
def test_without_a_site_the_target_runs_only_python_steps(copy: Path, target: str) -> None:
    result = make(copy, "-n", target)

    assert result.returncode == 0
    for step in PYTHON_STEPS[target]:
        assert step in result.stdout
    for command in WEB_COMMAND:
        assert command not in result.stdout


@pytest.mark.parametrize("target", ["web-install", "web-shots", "web-browser"])
def test_without_a_site_a_web_target_fails(copy: Path, target: str) -> None:
    result = make(copy, target)

    assert result.returncode != 0
    assert "No site here" in result.stdout


@pytest.mark.parametrize("target", sorted(PYTHON_STEPS))
def test_with_a_site_the_target_installs_the_site_before_any_other_site_step(
    copy: Path, target: str
) -> None:
    add_site(copy)

    lines = [line for line in make(copy, "-n", target).stdout.splitlines() if "--dir web" in line]

    assert lines
    assert "install" in lines[0]
    assert not any("install" in line for line in lines[1:])


def test_check_runs_the_python_steps_before_the_site_steps(copy: Path) -> None:
    add_site(copy)

    output = make(copy, "-n", "check").stdout

    assert output.index("pytest") < output.index("check-node.mjs") < output.index("--dir web")


def test_check_does_not_capture_screenshots(copy: Path) -> None:
    add_site(copy)

    assert "shots" not in make(copy, "-n", "check").stdout


def test_demo_builds_the_complete_sample_then_serves_it_on_localhost(copy: Path) -> None:
    add_site(copy)
    (copy / ".env").write_text("")

    output = make(copy, "-n", "demo").stdout

    build = output.index("fixtures/dataset/complete")
    assert output.index("install --frozen-lockfile") < build < output.index("http.server")
    assert "--bind 127.0.0.1" in output
    assert ".env" not in output


def test_demo_serves_on_the_port_it_is_given(copy: Path) -> None:
    add_site(copy)

    assert "127.0.0.1 8123" in make(copy, "-n", "demo", "DEMO_PORT=8123").stdout


def test_demo_without_a_site_fails_before_serving(copy: Path) -> None:
    result = make(copy, "demo")

    assert result.returncode != 0
    assert "No site here" in result.stdout
    assert "http.server" not in result.stdout


def test_web_steps_never_load_env(copy: Path) -> None:
    add_site(copy)
    (copy / ".env").write_text("")

    result = make(copy, "-n", "web-lint", "web-types", "web-test", "web-build", "web-shots")

    assert result.returncode == 0
    assert ".env" not in result.stdout


@pytest.mark.parametrize("target", ["check", "lint", "types", "test", "build", "web-install"])
def test_with_node_missing_the_target_fails_and_says_what_to_install(
    copy: Path, target: str
) -> None:
    add_site(copy)

    result = make(copy, target, env=tools_only(copy, "uv"))

    assert result.returncode != 0
    assert INSTALL_MESSAGE in result.stdout
    assert "pnpm" not in result.stdout


def test_with_npx_missing_the_target_fails_and_says_what_to_install(copy: Path) -> None:
    add_site(copy)

    result = make(copy, "check", env=tools_only(copy, "uv", "node"))

    assert result.returncode != 0
    assert "npx is missing" in result.stdout
    assert "^22.12 || ^24" in result.stdout


def test_with_node_out_of_range_no_web_step_runs(copy: Path) -> None:
    add_site(copy)

    result = make(copy, "check", env=tools_only(copy, "uv", "npx", failing=("node",)))

    assert result.returncode != 0
    assert "pnpm" not in result.stdout


def test_without_a_pnpm_version_no_web_step_runs(copy: Path) -> None:
    add_site(copy)
    (copy / "web" / "package.json").write_text("{}\n")

    result = make(copy, "web-install", env=tools_only(copy, "node", "npx"))

    assert result.returncode != 0
    assert "no packageManager" in result.stdout
    assert "npx --yes" not in result.stdout
