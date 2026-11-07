"""Dated, checksummed copies of the raw store, kept under a retention rule, and their restore.

A copy is one DuckDB file, `ousd-YYYYMMDDTHHMMSSZ.duckdb`, beside a `.sha256` in the format
`sha256sum -c` reads. The checksum is written last, so a copy without one is incomplete. When
OUSD_BACKUP_URL is set, the copy also goes to S3-compatible object storage.
"""

import contextlib
import functools
import hashlib
import logging
import os
import re
from collections.abc import Callable, Collection, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

import duckdb

from ousd import migrations
from ousd.store import checkpointed

# boto3 and its HTTP layer log request details at DEBUG, and the Authorization header names the
# access key. Setting this here covers every caller, not only the CLI.
for _name in ("boto3", "botocore", "s3transfer", "urllib3"):
    logging.getLogger(_name).setLevel(logging.WARNING)

DEFAULT_BACKUP_DIR = "data/backups"
DEFAULT_KEEP_DAILY = 7
DEFAULT_KEEP_WEEKLY = 4
# UTC, in names. NAME must match what it writes.
STAMP = "%Y%m%dT%H%M%SZ"
NAME = re.compile(r"ousd-(\d{8}T\d{6}Z)\.duckdb")
CHECKSUM_SUFFIX = ".sha256"
# A file being written: hidden, and renamed into place only when complete.
PARTIAL_SUFFIX = ".partial"
CHUNK = 1024 * 1024
# A bucket name as S3 and Scaleway accept it.
BUCKET = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")


class BackupError(RuntimeError):
    """A backup, upload or restore step failed. The message never holds a credential."""


class RestoreRefused(BackupError):
    """Restore would overwrite a database, and --force wasn't given."""


@dataclass(frozen=True)
class Remote:
    """Where copies go in object storage. The credentials never appear in a repr."""

    bucket: str
    prefix: str
    endpoint_url: str | None
    region: str | None
    access_key_id: str = field(repr=False)
    secret_access_key: str = field(repr=False)

    def url(self, name: str) -> str:
        return f"s3://{self.bucket}/{self.prefix}{name}"


@dataclass(frozen=True)
class Settings:
    folder: Path
    keep_daily: int
    keep_weekly: int
    remote: Remote | None


@dataclass(frozen=True)
class Backup:
    path: Path
    sha256: str
    size: int
    # None for a database from before schema versioning.
    schema_version: int | None


@dataclass(frozen=True)
class Restored:
    sha256: str
    schema_version: int | None
    # Where the database that was replaced now lives, if there was one.
    replaced: Path | None


class S3Client(Protocol):
    """The part of a boto3 S3 client that backups use, so tests can pass a fake."""

    def upload_file(self, *args: Any, **kwargs: Any) -> Any: ...
    def put_object(self, *args: Any, **kwargs: Any) -> Any: ...
    def head_object(self, *args: Any, **kwargs: Any) -> Any: ...
    def list_objects_v2(self, *args: Any, **kwargs: Any) -> Any: ...
    def delete_object(self, *args: Any, **kwargs: Any) -> Any: ...


def _count(env: Mapping[str, str], name: str, default: int, minimum: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    if not re.fullmatch(r"[0-9]+", raw) or int(raw) < minimum:
        raise BackupError(f"{name} must be a whole number of at least {minimum}")
    return int(raw)


def _remote(env: Mapping[str, str]) -> Remote | None:
    """Neither the URL nor the endpoint is ever echoed: a mistyped one could hold a key."""
    url = env.get("OUSD_BACKUP_URL", "").strip()
    if not url:
        return None
    parts = urlsplit(url)
    if (
        parts.scheme != "s3"
        or "@" in parts.netloc
        or parts.query
        or parts.fragment
        or not BUCKET.fullmatch(parts.netloc)
    ):
        raise BackupError("OUSD_BACKUP_URL must look like s3://bucket or s3://bucket/prefix")
    endpoint = env.get("OUSD_BACKUP_ENDPOINT_URL", "").strip() or None
    if endpoint is not None:
        site = urlsplit(endpoint)
        if site.scheme not in ("https", "http") or not site.hostname or "@" in site.netloc:
            raise BackupError(
                "OUSD_BACKUP_ENDPOINT_URL must be a plain URL such as https://s3.fr-par.scw.cloud"
            )
    names = ("OUSD_BACKUP_ACCESS_KEY_ID", "OUSD_BACKUP_SECRET_ACCESS_KEY")
    if missing := [name for name in names if not env.get(name, "").strip()]:
        raise BackupError(f"OUSD_BACKUP_URL is set, so set {' and '.join(missing)} too")
    prefix = parts.path.strip("/")
    return Remote(
        bucket=parts.netloc,
        prefix=f"{prefix}/" if prefix else "",
        endpoint_url=endpoint,
        region=env.get("OUSD_BACKUP_REGION", "").strip() or None,
        access_key_id=env["OUSD_BACKUP_ACCESS_KEY_ID"].strip(),
        secret_access_key=env["OUSD_BACKUP_SECRET_ACCESS_KEY"].strip(),
    )


def settings_from_env(env: Mapping[str, str]) -> Settings:
    return Settings(
        folder=Path(env.get("OUSD_BACKUP_DIR", "").strip() or DEFAULT_BACKUP_DIR),
        keep_daily=_count(env, "OUSD_BACKUP_KEEP_DAILY", DEFAULT_KEEP_DAILY, 1),
        keep_weekly=_count(env, "OUSD_BACKUP_KEEP_WEEKLY", DEFAULT_KEEP_WEEKLY, 0),
        remote=_remote(env),
    )


def backup_name(at: datetime) -> str:
    return f"ousd-{at.astimezone(UTC).strftime(STAMP)}.duckdb"


def taken_at(name: str) -> datetime | None:
    """When a copy was taken, from its name. None for any other file."""
    match = NAME.fullmatch(name)
    if match is None:
        return None
    try:
        return datetime.strptime(match.group(1), STAMP).replace(tzinfo=UTC)
    except ValueError:  # Named like a copy, but not a real time, such as month 13.
        return None


def checksum_path(path: Path) -> Path:
    return path.with_name(path.name + CHECKSUM_SUFFIX)


def wal_path(path: Path) -> Path:
    return path.with_name(path.name + ".wal")


def _copy(source: Path, target: Path) -> str:
    """Copy to a file that must not exist yet, flush it to disk, and return the sha256 of the
    bytes copied."""
    digest = hashlib.sha256()
    with source.open("rb") as reader, target.open("xb") as writer:
        while chunk := reader.read(CHUNK):
            digest.update(chunk)
            writer.write(chunk)
        writer.flush()
        os.fsync(writer.fileno())
    return digest.hexdigest()


def _sync_folder(folder: Path) -> None:
    """Make renames and links in the folder durable, so a crash can't reorder them."""
    descriptor = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as reader:
        while chunk := reader.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def schema_version(path: Path) -> int | None:
    """Open a copy read-only, which proves DuckDB can read it, and return its schema version."""
    try:
        db = duckdb.connect(str(path), read_only=True)
    except duckdb.Error:
        raise BackupError(f"{path.name} is not a database DuckDB can open") from None
    try:
        recorded = migrations.applied(db)
    finally:
        db.close()
    return max(recorded) if recorded else None


def read_checksum(path: Path) -> str:
    sidecar = checksum_path(path)
    if not sidecar.is_file():
        raise BackupError(f"{sidecar.name} is missing, so {path.name} can't be verified")
    fields = sidecar.read_text(encoding="utf-8", errors="replace").split()
    if not fields or not re.fullmatch(r"[0-9a-f]{64}", fields[0].lower()):
        raise BackupError(f"{sidecar.name} doesn't hold a sha256 checksum")
    return fields[0].lower()


def take(source: Path, folder: Path, at: datetime) -> Backup:
    """Copy the raw store into the folder under the writer lock. The lock is released before the
    copy is hashed and checked. Raises duckdb.IOException when another process holds the store."""
    folder.mkdir(parents=True, exist_ok=True)
    final = folder / backup_name(at)
    if final.exists() or checksum_path(final).exists():
        raise BackupError(f"{final.name} already exists; take the next one a second later")
    partial = folder / f".{final.name}{PARTIAL_SUFFIX}"
    pending = folder / f".{final.name}{CHECKSUM_SUFFIX}{PARTIAL_SUFFIX}"
    try:
        with checkpointed(source):
            # A WAL left after CHECKPOINT holds changes the file lacks, so the copy would too.
            if wal_path(source).exists():
                raise BackupError("the database still has a write-ahead log after CHECKPOINT")
            # DuckDB's lock is a POSIX record lock, which this process loses as soon as it closes
            # any descriptor on the file. The copy's own reader closes last in this block, so
            # nothing may open the source after it.
            _copy(source, partial)
        # From the file as written rather than the bytes read, and with the lock released.
        digest = file_sha256(partial)
        version = schema_version(partial)
        partial.rename(final)
        with pending.open("x", encoding="utf-8") as writer:
            writer.write(f"{digest}  {final.name}\n")
            writer.flush()
            os.fsync(writer.fileno())
        pending.rename(checksum_path(final))
        _sync_folder(folder)
    finally:
        partial.unlink(missing_ok=True)
        pending.unlink(missing_ok=True)
    return Backup(final, digest, final.stat().st_size, version)


def restore(backup: Path, target: Path, *, force: bool, at: datetime) -> Restored:
    """Verify a copy against its checksum and put it at target. An existing database is replaced
    only with force, and is kept beside it, renamed. Nothing changes unless the copy verifies.
    Raises duckdb.IOException when another process holds the target."""
    if not backup.is_file():
        raise BackupError(f"{backup} is not a file")
    expected = read_checksum(backup)
    if target.exists() and not force:
        raise RestoreRefused(
            f"a database already exists at {target}; pass --force to replace it "
            "(it is kept beside the restored one, renamed)"
        )
    if target.exists() and not target.is_file():
        raise BackupError(f"{target} is not a file")
    if not target.exists() and wal_path(target).exists():
        # DuckDB would replay a stale log onto the restored file.
        raise BackupError(f"{wal_path(target)} exists without its database; move it away first")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f".{target.name}.restoring")
    partial.unlink(missing_ok=True)
    try:
        digest = _copy(backup, partial)
        if digest != expected:
            raise BackupError(
                f"{backup.name} doesn't match its checksum: it is damaged, or not the file the "
                "checksum describes; nothing was changed"
            )
        version = schema_version(partial)
        if version is not None and version > migrations.LATEST:
            raise BackupError(
                f"{backup.name} is at schema version {version}, newer than this code's "
                f"{migrations.LATEST}, so nothing could open it; update the code first"
            )
        if not target.exists():
            # A link, unlike a rename, fails rather than replace a database created meanwhile.
            try:
                os.link(partial, target)
            except FileExistsError:
                raise BackupError(f"a database appeared at {target} during the restore") from None
            except OSError:
                raise BackupError(f"{target.parent} doesn't support hard links") from None
            _sync_folder(target.parent)
            return Restored(digest, version, None)
        replaced = target.with_name(f"{target.name}.replaced-{at.astimezone(UTC).strftime(STAMP)}")
        if replaced.exists():
            raise BackupError(f"{replaced} already exists; move it away first")
        with _replacing(target):
            # A second name for the old file, then one atomic swap, so the target never goes
            # missing for a writer to create an empty database there.
            try:
                os.link(target, replaced)
            except OSError:
                raise BackupError(f"{target.parent} doesn't support hard links") from None
            os.replace(partial, target)
        _sync_folder(target.parent)
        return Restored(digest, version, replaced)
    finally:
        partial.unlink(missing_ok=True)


@contextlib.contextmanager
def _replacing(target: Path) -> Iterator[None]:
    """The writer lock on a database about to be replaced. A file DuckDB can't open, such as a
    damaged one, can't be locked, so it is refused with what to do instead."""
    unopenable = BackupError(
        f"DuckDB can't open the database at {target}, so it can't be locked; if it is damaged, "
        "move it aside, then restore without --force"
    )
    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(checkpointed(target))
        except duckdb.IOException as exc:
            if "lock" in str(exc).lower():
                raise
            raise unopenable from None
        except duckdb.Error:
            raise unopenable from None
        if wal_path(target).exists():
            raise BackupError("the database still has a write-ahead log after CHECKPOINT")
        yield


def to_delete(
    names: Collection[str], keep_daily: int, keep_weekly: int, protect: str | None = None
) -> list[str]:
    """The files the retention rule removes, from a listing of file names.

    Only complete copies, with both files, count. Of those it keeps the newest copy of each of the
    `keep_daily` most recent UTC days that have one, and the newest of each of the `keep_weekly`
    most recent ISO weeks that have one; the two can overlap. Counting days with copies, rather
    than calendar days, means copies that stop never age out to nothing. An incomplete copy, or a
    partial file a killed run left, goes once a complete copy is newer. `protect`, the copy just
    taken, is always kept, even if a clock that stepped back makes it look old. Files not named
    like a copy are never touched.
    """
    stamps: dict[str, datetime] = {}
    leftovers: list[str] = []
    for name in names:
        if name.startswith(".") and name.endswith(PARTIAL_SUFFIX):
            leftovers.append(name)
            continue
        base = name.removesuffix(CHECKSUM_SUFFIX)
        if (at := taken_at(base)) is not None:
            stamps[base] = at
    complete = sorted(
        (base for base in stamps if base in names and base + CHECKSUM_SUFFIX in names),
        key=lambda base: stamps[base],
        reverse=True,
    )
    days: dict[date, str] = {}
    weeks: dict[tuple[int, int], str] = {}
    for base in complete:
        week = stamps[base].isocalendar()
        days.setdefault(stamps[base].date(), base)
        weeks.setdefault((week.year, week.week), base)
    kept = set(list(days.values())[:keep_daily]) | set(list(weeks.values())[:keep_weekly])
    kept |= {protect} if protect else set()
    newest = stamps[complete[0]] if complete else None
    doomed: list[str] = []
    for base, at in stamps.items():
        if base in kept or (base not in complete and (newest is None or at >= newest)):
            continue
        doomed.extend(name for name in (base, base + CHECKSUM_SUFFIX) if name in names)
    for name in leftovers:
        base = name[1 : -len(PARTIAL_SUFFIX)].removesuffix(CHECKSUM_SUFFIX)
        at = taken_at(base)
        if at is not None and newest is not None and at < newest:
            doomed.append(name)
    return sorted(doomed)


def prune_local(
    folder: Path, keep_daily: int, keep_weekly: int, protect: str | None = None
) -> list[str]:
    names = {path.name for path in folder.iterdir()}
    doomed = to_delete(names, keep_daily, keep_weekly, protect)
    for name in doomed:
        (folder / name).unlink(missing_ok=True)
    return doomed


def make_client(remote: Remote) -> S3Client:
    """A boto3 client given its credentials explicitly, so none comes from the environment, and
    no AWS_ENDPOINT_URL or shared config can send them to another endpoint."""
    # Imported here: boto3 takes a noticeable part of a second to load, and only uploads need it.
    import boto3
    from botocore.config import Config

    config = Config(
        # Recent boto3 adds checksum headers by default that some S3-compatible stores refuse.
        request_checksum_calculation="when_required",
        response_checksum_validation="when_required",
        ignore_configured_endpoint_urls=True,
        retries={"max_attempts": 5, "mode": "standard"},
    )
    client: S3Client = _call(
        remote,
        "client setup",
        functools.partial(
            boto3.client,
            "s3",
            endpoint_url=remote.endpoint_url,
            region_name=remote.region,
            aws_access_key_id=remote.access_key_id,
            aws_secret_access_key=remote.secret_access_key,
            config=config,
        ),
    )
    return client


def _failure(exc: BaseException, remote: Remote) -> str:
    """Only the error code or the exception's type: a provider's message or a botocore error can
    quote the request, and a request carries the access key."""
    response = getattr(exc, "response", None)
    code = response.get("Error", {}).get("Code") if isinstance(response, dict) else None
    text = str(code) if code else type(exc).__name__
    for secret in (remote.access_key_id, remote.secret_access_key):
        text = text.replace(secret, "[credential]")
    return text[:100]


def _call[T](remote: Remote, operation: str, call: Callable[[], T]) -> T:
    try:
        return call()
    except Exception as exc:
        failure = _failure(exc, remote)
    # Raised outside the except block, so the original isn't chained on as context.
    raise BackupError(f"object storage {operation} failed: {failure}")


def upload(made: Backup, remote: Remote, client: S3Client) -> str:
    """Upload the copy, check its size, then upload its checksum, which marks it complete."""
    key = remote.prefix + made.path.name
    _call(
        remote,
        "upload",
        lambda: client.upload_file(
            Filename=str(made.path),
            Bucket=remote.bucket,
            Key=key,
            ExtraArgs={"Metadata": {"sha256": made.sha256}},
        ),
    )
    head = _call(remote, "check", lambda: client.head_object(Bucket=remote.bucket, Key=key))
    if head.get("ContentLength") != made.size:
        raise BackupError(f"the uploaded {made.path.name} is not the size of the local copy")
    _call(
        remote,
        "upload",
        lambda: client.put_object(
            Bucket=remote.bucket,
            Key=key + CHECKSUM_SUFFIX,
            Body=checksum_path(made.path).read_bytes(),
            ContentType="text/plain",
        ),
    )
    return remote.url(made.path.name)


def prune_remote(
    remote: Remote, client: S3Client, keep_daily: int, keep_weekly: int, protect: str | None = None
) -> list[str]:
    """Apply the retention rule to the objects directly under the prefix."""
    names: set[str] = set()
    token: str | None = None
    while True:
        request: dict[str, Any] = {"Bucket": remote.bucket, "Prefix": remote.prefix}
        if token:
            request["ContinuationToken"] = token
        page = _call(remote, "listing", functools.partial(client.list_objects_v2, **request))
        for item in page.get("Contents", []):
            name = item["Key"][len(remote.prefix) :]
            if "/" not in name:
                names.add(name)
        if not page.get("IsTruncated"):
            break
        token = page.get("NextContinuationToken")
        if not token:
            raise BackupError("object storage listing was cut short without a way to continue")
    doomed = to_delete(names, keep_daily, keep_weekly, protect)
    for name in doomed:
        delete = functools.partial(
            client.delete_object, Bucket=remote.bucket, Key=remote.prefix + name
        )
        _call(remote, "delete", delete)
    return doomed
