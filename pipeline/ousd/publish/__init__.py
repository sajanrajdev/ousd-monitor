"""Writes the versioned dataset the site reads, and refuses unless every check passed in this run.

Everything is built and validated in memory first, so a failure can't leave a half dataset. A
refusal leaves the last good dataset where it is, and marks it stale.

--allow-partial is a local preview for site development, never a release. It writes under a
different folder, under a different pointer, with `preview: true` in every JSON file.

`publish` is the one entry point. build assembles the files, safety refuses what must not leave,
provenance records what built them, and install puts them in place. The names below are re-exported
so callers import from `ousd.publish` alone.
"""

import logging
from datetime import datetime
from pathlib import Path

import duckdb

from ousd.checks import Sources, utc_moment
from ousd.migrations import SchemaOutOfDate
from ousd.publish.build import (
    _AMOUNTS,
    DAY_ZERO,
    INDEPENDENCE_NOTICE,
    PREVIEW_CSV_MARK,
    PREVIEW_NOTICE,
    UNNAMED_RULE_REFERENCE,
    VELOCITY_DEFINITIONS,
    _build_files,
    _csv_bytes,
    _dataset_version,
    _definitions,
    _exchange_holdings,
    _labels_payload,
)
from ousd.publish.errors import PublishRefused, PublishUnavailable
from ousd.publish.install import (
    DEFAULT_PUBLISHED_DIR,
    KEEP_FOLDERS,
    LATEST,
    LATEST_PREVIEW,
    PREVIEW_DIRNAME,
    STALE_FILE,
    _install,
    _point,
    _prune,
    mark_stale,
)
from ousd.publish.provenance import COMMIT_ENV, UV_LOCK, _git_commit, _provenance
from ousd.publish.safety import (
    LISTING_SOURCE_TYPE,
    _looks_like_a_name,
    _read_exchange_listings,
    _read_legend,
    _read_source_hosts,
    _read_unnamed_rule,
    _refuse_bad_source,
    _refuse_unsafe_dataset,
    _token_contracts,
    _wallet_shapes,
)
from ousd.publish.schema import MANIFEST_SCHEMA_VERSION, SCHEMA_DIR, SCHEMA_VERSION, _validate
from ousd.store import Store

__all__ = [
    "COMMIT_ENV",
    "DAY_ZERO",
    "DEFAULT_PUBLISHED_DIR",
    "INDEPENDENCE_NOTICE",
    "KEEP_FOLDERS",
    "LATEST",
    "LATEST_PREVIEW",
    "LISTING_SOURCE_TYPE",
    "MANIFEST_SCHEMA_VERSION",
    "PREVIEW_CSV_MARK",
    "PREVIEW_DIRNAME",
    "PREVIEW_NOTICE",
    "SCHEMA_DIR",
    "SCHEMA_VERSION",
    "STALE_FILE",
    "UNNAMED_RULE_REFERENCE",
    "UV_LOCK",
    "VELOCITY_DEFINITIONS",
    "_AMOUNTS",
    "PublishRefused",
    "PublishUnavailable",
    "_csv_bytes",
    "_definitions",
    "_exchange_holdings",
    "_git_commit",
    "_labels_payload",
    "_looks_like_a_name",
    "_point",
    "_provenance",
    "_prune",
    "_read_exchange_listings",
    "_read_legend",
    "_read_source_hosts",
    "_read_unnamed_rule",
    "_refuse_bad_source",
    "_refuse_unsafe_dataset",
    "_token_contracts",
    "_validate",
    "_wallet_shapes",
    "mark_stale",
    "publish",
]

logger = logging.getLogger(__name__)


def _read_and_build(
    run_id: str,
    marts_path: Path,
    raw_path: Path,
    moment: datetime,
    allow_partial: bool,
    sources: Sources,
) -> tuple[str, dict[str, bytes]]:
    # A missing file would read as in use, and that is not the refusal to explain.
    if not raw_path.is_file():
        raise PublishRefused("the raw database does not exist")
    if not marts_path.is_file():
        raise PublishRefused("the marts database does not exist, so run dbt first")
    try:
        store = Store(raw_path, read_only=True)
    except duckdb.IOException as exc:
        raise PublishUnavailable("the raw database is in use by another process") from exc
    except SchemaOutOfDate as exc:
        # Says nothing about the data, so the last good dataset isn't called stale.
        raise PublishUnavailable(str(exc)) from exc
    try:
        marts = duckdb.connect(str(marts_path), read_only=True)
    except duckdb.IOException as exc:
        store.close()
        raise PublishUnavailable("the marts database is in use by another process") from exc
    try:
        return _build_files(run_id, store, marts, moment, allow_partial, sources)
    finally:
        marts.close()
        store.close()


def publish(
    run_id: str,
    marts_path: Path,
    raw_path: Path,
    out_root: Path,
    allow_partial: bool = False,
    now: datetime | None = None,
    sources: Sources | None = None,
) -> Path:
    """Read check_results for run_id and refuse unless all seven are present and acceptable.

    Build and validate everything, write a new dated folder, then repoint the pointer. Return the
    new folder. On any failure the pointer and every published number stay as they were, and a
    real publish marks the last good dataset stale. A preview touches nothing under out_root.
    """
    moment = utc_moment(now)
    files_from = sources or Sources()
    root = out_root.parent / PREVIEW_DIRNAME if allow_partial else out_root
    pointer = LATEST_PREVIEW if allow_partial else LATEST
    # Versions have one-second resolution. A second publish that fast says nothing about the data.
    if (root / _dataset_version(moment, allow_partial)).exists():
        raise PublishUnavailable("a dataset with this version exists, so try again in a second")
    try:
        version, files = _read_and_build(
            run_id, marts_path, raw_path, moment, allow_partial, files_from
        )
        folder = _install(root, version, files, pointer)
    except PublishUnavailable:
        raise
    except Exception as exc:
        reason = str(exc) if isinstance(exc, PublishRefused) else type(exc).__name__
        if not allow_partial:
            try:
                mark_stale(out_root, moment, reason)
            except Exception as stale_error:
                raise PublishRefused(
                    f"{reason}. The last good dataset could not be marked stale: "
                    f"{type(stale_error).__name__}"
                ) from exc
        if isinstance(exc, PublishRefused):
            raise
        raise PublishRefused(f"publish failed: {reason}") from exc
    try:
        _prune(root, pointer)
    except OSError as exc:
        logger.warning("could not prune old datasets: %s", type(exc).__name__)
    return folder
