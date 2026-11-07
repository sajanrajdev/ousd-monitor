"""Where a dataset lands: a temporary folder renamed into place, a pointer swapped in one step,
old folders pruned, and a stale.json beside a dataset that is no longer current.
"""

import json
import logging
import os
import re
import shutil
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path

from ousd.checks import utc_moment, utc_text
from ousd.publish.schema import _json_bytes, _validate

logger = logging.getLogger(__name__)

DEFAULT_PUBLISHED_DIR = "data/published"
# A sibling of the real output, so nothing that reads data/published can land on it.
PREVIEW_DIRNAME = "preview-not-for-release"
LATEST = "latest"
LATEST_PREVIEW = "latest-preview"
KEEP_FOLDERS = 14
# Written beside a published folder's files once it is no longer current, so they never change.
STALE_FILE = "stale.json"
_UTC_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")

_STAMP = re.compile(r"^(preview-)?[0-9]{8}T[0-9]{6}Z(\.tmp)?$")


def _point(root: Path, pointer: str, target: str) -> None:
    """Swap the pointer in one step, so a reader sees the old dataset or the new one."""
    temporary = root / f"{pointer}.tmp"
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    os.replace(temporary, root / pointer)


def _install(root: Path, version: str, files: Mapping[str, bytes], pointer: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / f"{version}.tmp"
    final = root / version
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir()
    try:
        for name, data in files.items():
            (temporary / name).write_bytes(data)
        temporary.rename(final)
        try:
            _point(root, pointer, version)
        except BaseException:
            # Ctrl-C can land after the swap, and the pointer must never be left dangling.
            if os.path.realpath(root / pointer) != os.path.realpath(final):
                shutil.rmtree(final, ignore_errors=True)
            raise
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return final


def _prune(root: Path, pointer: str) -> None:
    """Keep the newest folders. The pointer's target stays, whatever its age."""
    current = (root / pointer).resolve().name
    folders = sorted(
        path.name
        for path in root.iterdir()
        if path.is_dir() and not path.is_symlink() and _STAMP.match(path.name)
    )
    finished = [name for name in folders if not name.endswith(".tmp")]
    doomed = [name for name in folders if name.endswith(".tmp")]
    doomed += finished[:-KEEP_FOLDERS]
    for name in doomed:
        if name != current:
            shutil.rmtree(root / name, ignore_errors=True)


def _first_stale_since(folder: Path) -> str | None:
    """When the folder first went stale: from its stale.json, or else from a version 2 manifest,
    which held its own mark. Anything unreadable counts as no time, so it can't stop a mark."""
    for name in (STALE_FILE, "manifest.json"):
        try:
            since = json.loads((folder / name).read_text()).get("stale_since")
        except (OSError, ValueError, AttributeError) as exc:
            if not isinstance(exc, FileNotFoundError):
                logger.warning("ignored an unreadable %s: %s", name, type(exc).__name__)
            continue
        if isinstance(since, str) and _UTC_TIME.fullmatch(since):
            return since
    return None


def mark_stale(out_root: Path, now: datetime | None = None, reason: str = "") -> bool:
    """Say beside the last good dataset that it is no longer current. Only stale.json is written,
    in one step, so the published files never change. False when there is nothing to mark.

    It keeps the first time the dataset went stale, and the newest reason. A damaged stale.json is
    replaced, so it can't stop this mark or any later one.
    """
    moment = utc_moment(now)
    if not (out_root / LATEST).exists():
        return False
    # Resolved once, so a pointer that moves can't send this mark into another folder.
    folder = (out_root / LATEST).resolve()
    path = folder / STALE_FILE
    since = _first_stale_since(folder) or utc_text(moment)
    mark = {"stale_since": since, "stale_reason": reason}
    _validate(STALE_FILE, mark)
    temporary = path.with_name(f"{STALE_FILE}.tmp")
    try:
        temporary.write_bytes(_json_bytes(mark))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return True
