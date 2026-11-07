"""What built a dataset, beside its data: the commit and its tree, uv.lock, the Python and
dbt versions, the raw schema and the compiled dbt manifest.
"""

import hashlib
import json
import os
import platform
import re
import subprocess
from importlib import metadata
from pathlib import Path
from typing import Any

from ousd.checks import Sources
from ousd.migrations import applied
from ousd.publish.errors import PublishRefused
from ousd.store import Store

# Relative to the repo root, where every command runs, as in Sources.
UV_LOCK = Path("uv.lock")
# A full commit hash, and nothing else, so the variable can't carry other text into the manifest.
_COMMIT_HASH = re.compile(r"[0-9a-f]{40}")
COMMIT_ENV = "OUSD_GIT_COMMIT"


def _git(*args: str) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            ["git", "--no-optional-locks", *args],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def _git_commit() -> tuple[str, str]:
    """The checkout's commit and whether its tree had changes, or else OUSD_GIT_COMMIT where there
    is no checkout, as in an image. A tree that can't be read is unknown, never assumed clean."""
    head = _git("rev-parse", "HEAD")
    if head is not None and head.returncode == 0:
        commit = head.stdout.strip()
        if not _COMMIT_HASH.fullmatch(commit):
            raise PublishRefused("git printed something other than a commit hash")
        # Untracked files count, as dbt reads a new model whether or not git knows it. Named, so a
        # user's status.showUntrackedFiles can't hide them.
        status = _git("status", "--porcelain", "--untracked-files=normal")
        if status is None or status.returncode != 0:
            return commit, "unknown"
        return commit, "dirty" if status.stdout.strip() else "clean"
    supplied = os.environ.get(COMMIT_ENV, "")
    if not supplied:
        raise PublishRefused("cannot read the git commit, so this dataset couldn't be traced")
    if not _COMMIT_HASH.fullmatch(supplied):
        # The rule, never the value.
        raise PublishRefused(f"{COMMIT_ENV} isn't a full lowercase commit hash of 40 characters")
    return supplied, "unknown"


def _installed(package: str) -> str:
    try:
        return metadata.version(package)
    except metadata.PackageNotFoundError as exc:
        raise PublishRefused(
            f"{package} isn't installed, so this dataset couldn't be traced"
        ) from exc


def _read_traced(path: Path, what: str) -> bytes:
    try:
        return path.read_bytes()
    except OSError as exc:
        raise PublishRefused(f"cannot read {what}, so this dataset couldn't be traced") from exc


def _invocation_id(raw: bytes, what: str) -> str:
    try:
        found = json.loads(raw)["metadata"]["invocation_id"]
    except (ValueError, TypeError, KeyError):
        found = None
    if not isinstance(found, str) or not found:
        raise PublishRefused(f"{what} names no dbt invocation, so this dataset couldn't be traced")
    return found


def _dbt_manifest_sha256(sources: Sources) -> str:
    """The compiled dbt manifest's hash, once its invocation is shown to be the one in run_results,
    so a manifest left by another dbt command can't be recorded as this build's."""
    what = "the compiled dbt manifest"
    raw = _read_traced(sources.run_results.with_name("manifest.json"), what)
    built = _invocation_id(raw, what)
    checked = _invocation_id(
        _read_traced(sources.run_results, "dbt's run results"), "dbt's run results"
    )
    if built != checked:
        raise PublishRefused(f"{what} is from another dbt invocation than the run results")
    return hashlib.sha256(raw).hexdigest()


def _provenance(tree_state: str, store: Store, sources: Sources) -> dict[str, Any]:
    """What else built this dataset, beside the commit. The dbt manifest is the one beside
    run_results, which the checks read, and from the same dbt invocation."""
    return {
        "tree_state": tree_state,
        "uv_lock_sha256": hashlib.sha256(_read_traced(UV_LOCK, "uv.lock")).hexdigest(),
        "python_version": platform.python_version(),
        "dbt_core_version": _installed("dbt-core"),
        "dbt_duckdb_version": _installed("dbt-duckdb"),
        "raw_schema_version": max(applied(store.db), default=0),
        "dbt_manifest_sha256": _dbt_manifest_sha256(sources),
    }
