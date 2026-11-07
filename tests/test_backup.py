import hashlib
import subprocess
import sys
from datetime import UTC, datetime, timedelta, timezone

import duckdb
import pytest
from conftest import ALICE
from ousd import backup, cli
from ousd.backup import BackupError, Remote, RestoreRefused
from ousd.decode import Transfer
from ousd.migrations import LATEST, SchemaOutOfDate
from ousd.store import Store
from test_migrations import PRE_MIGRATIONS_SCHEMA

TRANSFER = Transfer(5, "0xhash5", 1, "0x2", 0, ALICE, ALICE, 7)
AT = datetime(2026, 11, 6, 6, 30, 5, tzinfo=UTC)
REMOTE = Remote(
    bucket="ousd-backups",
    prefix="raw/",
    endpoint_url="https://s3.fr-par.scw.cloud",
    region="fr-par",
    access_key_id="SCWACCESSKEYID000000",
    secret_access_key="secret-access-key-0000000000000000",
)


class FakeS3:
    """An in-memory bucket with the calls backups make. It never opens a connection."""

    def __init__(self, page_size: int = 1000) -> None:
        self.objects: dict[str, bytes] = {}
        self.metadata: dict[str, dict[str, str]] = {}
        self.page_size = page_size
        self.fail: dict[str, Exception] = {}
        self.short_by = 0

    def _check(self, operation: str) -> None:
        if operation in self.fail:
            raise self.fail[operation]

    def upload_file(self, *, Filename, Bucket, Key, ExtraArgs=None):
        self._check("upload_file")
        assert Bucket == REMOTE.bucket
        with open(Filename, "rb") as reader:
            self.objects[Key] = reader.read()[: -self.short_by or None]
        self.metadata[Key] = (ExtraArgs or {}).get("Metadata", {})

    def put_object(self, *, Bucket, Key, Body, ContentType=None):
        self._check("put_object")
        self.objects[Key] = Body

    def head_object(self, *, Bucket, Key):
        self._check("head_object")
        return {"ContentLength": len(self.objects[Key])}

    def list_objects_v2(self, *, Bucket, Prefix, ContinuationToken=None):
        self._check("list_objects_v2")
        keys = sorted(key for key in self.objects if key.startswith(Prefix))
        start = int(ContinuationToken or 0)
        page = keys[start : start + self.page_size]
        more = start + self.page_size < len(keys)
        reply = {"Contents": [{"Key": key} for key in page], "IsTruncated": more}
        if more:
            reply["NextContinuationToken"] = str(start + self.page_size)
        return reply

    def delete_object(self, *, Bucket, Key):
        self._check("delete_object")
        self.objects.pop(Key, None)


@pytest.fixture
def raw(tmp_path):
    path = tmp_path / "ousd.duckdb"
    store = Store(path)
    store.write_range("tempo", [TRANSFER], {5: "0xhash5"}, 10)
    store.close()
    return path


def transfer_count(path) -> int:
    db = duckdb.connect(str(path), read_only=True)
    try:
        row = db.execute("SELECT count(*) FROM transfers").fetchone()
    finally:
        db.close()
    assert row is not None
    return row[0]


def hold(path):
    """Open the file from another process, where DuckDB's file lock applies."""
    holder = subprocess.Popen(
        [
            sys.executable,
            "-I",
            "-c",
            "import duckdb, sys; db = duckdb.connect(sys.argv[1]);"
            " print('held', flush=True); input()",
            str(path),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert holder.stdout is not None
    assert holder.stdout.readline().strip() == "held"
    return holder


def names(*times: datetime, complete: bool = True) -> set[str]:
    made = {backup.backup_name(at) for at in times}
    return made | ({name + ".sha256" for name in made} if complete else set())


# Taking a copy


def test_a_backup_is_a_dated_copy_with_a_checksum_sha256sum_reads(raw, tmp_path):
    folder = tmp_path / "backups"

    made = backup.take(raw, folder, AT)

    assert made.path == folder / "ousd-20261106T063005Z.duckdb"
    assert made.sha256 == hashlib.sha256(made.path.read_bytes()).hexdigest()
    assert made.size == made.path.stat().st_size
    assert made.schema_version == LATEST
    sidecar = folder / "ousd-20261106T063005Z.duckdb.sha256"
    assert sidecar.read_text() == f"{made.sha256}  ousd-20261106T063005Z.duckdb\n"
    assert transfer_count(made.path) == 1
    assert sorted(path.name for path in folder.iterdir()) == [made.path.name, sidecar.name]


def test_a_backup_converts_a_non_utc_time_to_utc_in_its_name():
    east = datetime(2026, 11, 6, 12, 30, 5, tzinfo=timezone(timedelta(hours=3)))
    assert backup.backup_name(east) == "ousd-20261106T093005Z.duckdb"


def test_a_backup_holds_what_is_still_only_in_the_write_ahead_log(tmp_path):
    path = tmp_path / "ousd.duckdb"
    store = Store(path)
    try:
        store.write_range("tempo", [TRANSFER], {5: "0xhash5"}, 10)
        assert backup.wal_path(path).exists()

        made = backup.take(path, tmp_path / "backups", AT)
    finally:
        store.close()

    assert transfer_count(made.path) == 1


def test_a_backup_never_migrates_the_source_and_keeps_its_schema(tmp_path):
    path = tmp_path / "old.duckdb"
    db = duckdb.connect(str(path))
    db.execute(PRE_MIGRATIONS_SCHEMA)
    db.close()

    made = backup.take(path, tmp_path / "backups", AT)

    assert made.schema_version is None
    with pytest.raises(SchemaOutOfDate):
        Store(path, read_only=True)


def test_a_second_backup_in_the_same_second_is_refused_and_keeps_the_first(raw, tmp_path):
    folder = tmp_path / "backups"
    first = backup.take(raw, folder, AT)

    with pytest.raises(BackupError, match="already exists"):
        backup.take(raw, folder, AT)

    assert backup.read_checksum(first.path) == first.sha256


def test_a_failed_check_of_the_copy_leaves_nothing_behind(raw, tmp_path, monkeypatch):
    def broken(path):
        raise BackupError("not a database")

    monkeypatch.setattr(backup, "schema_version", broken)
    folder = tmp_path / "backups"

    with pytest.raises(BackupError):
        backup.take(raw, folder, AT)

    assert list(folder.iterdir()) == []


def test_a_held_database_is_not_copied(raw, tmp_path):
    holder = hold(raw)
    try:
        with pytest.raises(duckdb.IOException):
            backup.take(raw, tmp_path / "backups", AT)
    finally:
        holder.communicate("\n", timeout=30)

    assert list((tmp_path / "backups").iterdir()) == []


# Retention


def test_retention_keeps_the_newest_copy_of_each_of_the_last_days():
    days = [AT - timedelta(days=n) for n in range(10)]

    doomed = backup.to_delete(names(*days), keep_daily=7, keep_weekly=0)

    assert doomed == sorted(names(*days[7:]))


def test_retention_keeps_one_copy_a_day_the_newest():
    morning, evening = AT.replace(hour=1), AT.replace(hour=22)

    doomed = backup.to_delete(names(morning, evening), keep_daily=7, keep_weekly=0)

    assert doomed == sorted(names(morning))


def test_retention_keeps_the_newest_copy_of_each_of_the_last_weeks():
    # 2026-11-06 is a Friday, in ISO week 45.
    days = [AT - timedelta(days=n) for n in range(60)]

    kept = names(*days) - set(backup.to_delete(names(*days), keep_daily=7, keep_weekly=4))

    kept_days = sorted({name.removesuffix(".sha256") for name in kept})
    # Weeks 45 and 44 end inside the daily window. Weeks 43 and 42 add their Sundays.
    sundays = [datetime(2026, 10, day, 6, 30, 5, tzinfo=UTC) for day in (25, 18)]
    assert kept_days == sorted(backup.backup_name(at) for at in [*sundays, *days[:7]])


def test_no_weekly_copies_with_keep_weekly_zero():
    days = [AT - timedelta(days=n) for n in range(30)]

    kept = names(*days) - set(backup.to_delete(names(*days), keep_daily=3, keep_weekly=0))

    assert kept == names(*days[:3])


def test_copies_that_stopped_long_ago_are_never_all_removed():
    old = [AT - timedelta(days=400 + n) for n in range(3)]

    assert backup.to_delete(names(*old), keep_daily=7, keep_weekly=4) == []


def test_only_complete_copies_count_and_an_older_incomplete_one_goes():
    complete = [AT - timedelta(days=n) for n in range(1, 4)]
    stale = AT - timedelta(days=10)
    in_progress = AT
    listing = names(*complete) | names(stale, in_progress, complete=False)

    doomed = backup.to_delete(listing, keep_daily=3, keep_weekly=0)

    assert doomed == [backup.backup_name(stale)]


def test_a_checksum_without_its_copy_is_incomplete_too():
    listing = names(AT) | {backup.backup_name(AT - timedelta(days=1)) + ".sha256"}

    doomed = backup.to_delete(listing, keep_daily=1, keep_weekly=0)

    assert doomed == [backup.backup_name(AT - timedelta(days=1)) + ".sha256"]


def test_retention_never_touches_files_not_named_like_a_copy():
    days = [AT - timedelta(days=n) for n in range(3)]
    others = {
        "ousd.duckdb",
        "notes.txt",
        "ousd-2026.duckdb",
        "ousd-20261341T000000Z.duckdb",
        ".notes.partial",
    }

    doomed = backup.to_delete(names(*days) | others, keep_daily=1, keep_weekly=0)

    assert not set(doomed) & others
    assert doomed == sorted(names(*days[1:]))


def test_partial_files_a_killed_run_left_go_once_a_newer_copy_is_complete():
    killed = backup.backup_name(AT - timedelta(days=1))
    running = backup.backup_name(AT + timedelta(minutes=1))
    leftovers = {f".{killed}.partial", f".{killed}.sha256.partial"}
    in_progress = {f".{running}.partial"}

    doomed = backup.to_delete(names(AT) | leftovers | in_progress, keep_daily=7, keep_weekly=0)

    assert doomed == sorted(leftovers)


def test_the_copy_just_taken_is_kept_even_when_the_clock_stepped_back():
    newer = [AT - timedelta(days=n) for n in range(3)]
    stepped_back = AT - timedelta(days=30)
    listing = names(*newer, stepped_back)

    protected = backup.to_delete(
        listing, keep_daily=3, keep_weekly=0, protect=backup.backup_name(stepped_back)
    )

    assert backup.to_delete(listing, keep_daily=3, keep_weekly=0) == sorted(names(stepped_back))
    assert protected == []


def test_only_incomplete_copies_are_never_removed():
    listing = names(AT, AT - timedelta(days=9), complete=False)

    assert backup.to_delete(listing, keep_daily=1, keep_weekly=0) == []


def test_weeks_are_iso_weeks_across_a_year_boundary():
    # 2025-12-29 and 2026-01-01 are both in ISO week 1 of 2026; 2025-12-28 ends 2025's week 52.
    days = [
        datetime(year, month, day, tzinfo=UTC)
        for year, month, day in ((2026, 1, 1), (2025, 12, 29), (2025, 12, 28))
    ]

    doomed = backup.to_delete(names(*days), keep_daily=1, keep_weekly=2)

    assert doomed == sorted(names(days[1]))


def test_a_name_like_a_copy_with_an_impossible_time_is_not_a_copy():
    assert backup.taken_at("ousd-20261341T000000Z.duckdb") is None
    assert backup.taken_at("ousd-20261106T063005Z.duckdb") == AT


def test_local_pruning_removes_expired_copies_from_the_folder(raw, tmp_path):
    folder = tmp_path / "backups"
    for n in range(3):
        backup.take(raw, folder, AT - timedelta(days=n))
    (folder / "keep-me.txt").write_text("x")

    removed = backup.prune_local(folder, keep_daily=1, keep_weekly=0)

    assert len(removed) == 4
    assert sorted(path.name for path in folder.iterdir()) == sorted([*names(AT), "keep-me.txt"])


# Settings


def test_settings_have_stated_defaults_and_no_remote():
    settings = backup.settings_from_env({})

    assert str(settings.folder) == "data/backups"
    assert (settings.keep_daily, settings.keep_weekly) == (7, 4)
    assert settings.remote is None


def test_settings_take_overrides_from_the_environment():
    settings = backup.settings_from_env(
        {
            "OUSD_BACKUP_DIR": "/srv/copies",
            "OUSD_BACKUP_KEEP_DAILY": "3",
            "OUSD_BACKUP_KEEP_WEEKLY": "0",
            "OUSD_BACKUP_URL": "s3://ousd-backups/raw/daily/",
            "OUSD_BACKUP_ENDPOINT_URL": "https://s3.fr-par.scw.cloud",
            "OUSD_BACKUP_REGION": "fr-par",
            "OUSD_BACKUP_ACCESS_KEY_ID": "id",
            "OUSD_BACKUP_SECRET_ACCESS_KEY": "secret",
        }
    )

    assert str(settings.folder) == "/srv/copies"
    assert (settings.keep_daily, settings.keep_weekly) == (3, 0)
    assert settings.remote is not None
    assert (settings.remote.bucket, settings.remote.prefix) == ("ousd-backups", "raw/daily/")
    assert settings.remote.url("x") == "s3://ousd-backups/raw/daily/x"


def test_a_bucket_without_a_prefix_writes_at_its_root():
    remote = backup.settings_from_env(
        {
            "OUSD_BACKUP_URL": "s3://ousd-backups",
            "OUSD_BACKUP_ACCESS_KEY_ID": "id",
            "OUSD_BACKUP_SECRET_ACCESS_KEY": "secret",
        }
    ).remote

    assert remote is not None
    assert remote.prefix == ""
    assert remote.endpoint_url is None


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("OUSD_BACKUP_KEEP_DAILY", "0"),
        ("OUSD_BACKUP_KEEP_DAILY", "seven"),
        ("OUSD_BACKUP_KEEP_DAILY", "\u0667"),  # An Arabic-Indic seven, which str.isdigit accepts.
        ("OUSD_BACKUP_KEEP_WEEKLY", "-1"),
    ],
)
def test_a_bad_retention_count_is_refused(name, value):
    with pytest.raises(BackupError, match=name):
        backup.settings_from_env({name: value})


@pytest.mark.parametrize(
    "url", ["https://ousd-backups/raw", "s3://", "s3://Bad_Bucket/raw", "s3://b/raw?x=1"]
)
def test_a_url_that_is_not_an_s3_bucket_is_refused(url):
    env = {
        "OUSD_BACKUP_URL": url,
        "OUSD_BACKUP_ACCESS_KEY_ID": "id",
        "OUSD_BACKUP_SECRET_ACCESS_KEY": "secret",
    }
    with pytest.raises(BackupError, match="s3://bucket"):
        backup.settings_from_env(env)


def test_a_blank_retention_count_takes_the_default():
    assert backup.settings_from_env({"OUSD_BACKUP_KEEP_DAILY": "  "}).keep_daily == 7


@pytest.mark.parametrize(
    "endpoint", ["ftp://s3.example.invalid", "s3.fr-par.scw.cloud", "https://"]
)
def test_an_endpoint_that_is_not_an_http_url_is_refused(endpoint):
    env = {
        "OUSD_BACKUP_URL": "s3://ousd-backups",
        "OUSD_BACKUP_ENDPOINT_URL": endpoint,
        "OUSD_BACKUP_ACCESS_KEY_ID": "id",
        "OUSD_BACKUP_SECRET_ACCESS_KEY": "secret",
    }
    with pytest.raises(BackupError, match="OUSD_BACKUP_ENDPOINT_URL must be a plain URL"):
        backup.settings_from_env(env)


def test_a_url_without_either_credential_names_both():
    with pytest.raises(BackupError) as raised:
        backup.settings_from_env({"OUSD_BACKUP_URL": "s3://ousd-backups"})

    assert "OUSD_BACKUP_ACCESS_KEY_ID and OUSD_BACKUP_SECRET_ACCESS_KEY" in str(raised.value)


def test_a_url_without_credentials_names_what_is_missing():
    with pytest.raises(BackupError, match="OUSD_BACKUP_SECRET_ACCESS_KEY") as raised:
        backup.settings_from_env(
            {"OUSD_BACKUP_URL": "s3://ousd-backups", "OUSD_BACKUP_ACCESS_KEY_ID": "id"}
        )

    assert "OUSD_BACKUP_ACCESS_KEY_ID" not in str(raised.value)


# Upload


def test_an_upload_puts_the_copy_then_its_checksum(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    s3 = FakeS3()

    url = backup.upload(made, REMOTE, s3)

    assert url == "s3://ousd-backups/raw/ousd-20261106T063005Z.duckdb"
    assert s3.objects["raw/ousd-20261106T063005Z.duckdb"] == made.path.read_bytes()
    assert s3.objects["raw/ousd-20261106T063005Z.duckdb.sha256"] == (
        backup.checksum_path(made.path).read_bytes()
    )
    assert s3.metadata["raw/ousd-20261106T063005Z.duckdb"] == {"sha256": made.sha256}


def test_an_upload_of_the_wrong_size_is_not_marked_complete(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    s3 = FakeS3()
    s3.short_by = 1

    with pytest.raises(BackupError, match="not the size"):
        backup.upload(made, REMOTE, s3)

    assert "raw/ousd-20261106T063005Z.duckdb.sha256" not in s3.objects


def test_a_failed_upload_names_the_step_and_the_error_code(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    s3 = FakeS3()
    failure = RuntimeError("provider text")
    failure.response = {"Error": {"Code": "AccessDenied"}}  # type: ignore[attr-defined]
    s3.fail["upload_file"] = failure

    with pytest.raises(BackupError, match="object storage upload failed: AccessDenied") as raised:
        backup.upload(made, REMOTE, s3)

    assert "provider text" not in str(raised.value)
    assert raised.value.__context__ is None


def test_remote_pruning_applies_the_rule_across_pages_and_only_under_the_prefix():
    s3 = FakeS3(page_size=3)
    days = [AT - timedelta(days=n) for n in range(5)]
    for name in names(*days):
        s3.objects["raw/" + name] = b"x"
    s3.objects["raw/older/" + backup.backup_name(days[-1])] = b"x"
    s3.objects["other/" + backup.backup_name(days[-1])] = b"x"

    removed = backup.prune_remote(REMOTE, s3, keep_daily=2, keep_weekly=0)

    assert removed == sorted(names(*days[2:]))
    assert sorted(s3.objects) == sorted(
        ["other/" + backup.backup_name(days[-1]), "raw/older/" + backup.backup_name(days[-1])]
        + ["raw/" + name for name in names(*days[:2])]
    )


def test_a_listing_cut_short_without_a_token_is_an_error():
    s3 = FakeS3()
    s3.list_objects_v2 = lambda **kwargs: {"Contents": [], "IsTruncated": True}  # type: ignore[method-assign]

    with pytest.raises(BackupError, match="cut short"):
        backup.prune_remote(REMOTE, s3, keep_daily=1, keep_weekly=0)


# Restoring


def test_a_restore_verifies_the_checksum_and_puts_the_copy_in_place(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    target = tmp_path / "restored" / "ousd.duckdb"

    restored = backup.restore(made.path, target, force=False, at=AT)

    assert restored.sha256 == made.sha256
    assert restored.replaced is None
    assert restored.schema_version == LATEST
    assert target.read_bytes() == made.path.read_bytes()
    assert sorted(path.name for path in target.parent.iterdir()) == ["ousd.duckdb"]


def test_a_restore_refuses_an_existing_database_without_force(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    target = tmp_path / "live.duckdb"
    Store(target).close()
    before = target.read_bytes()

    with pytest.raises(RestoreRefused, match="--force"):
        backup.restore(made.path, target, force=False, at=AT)

    assert target.read_bytes() == before


def test_a_forced_restore_replaces_the_database_and_keeps_the_old_one(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    target = tmp_path / "live.duckdb"
    Store(target).close()
    before = target.read_bytes()

    restored = backup.restore(made.path, target, force=True, at=AT)

    replaced = tmp_path / "live.duckdb.replaced-20261106T063005Z"
    assert restored.replaced == replaced
    assert replaced.read_bytes() == before
    assert target.read_bytes() == made.path.read_bytes()
    assert transfer_count(target) == 1


def test_a_copy_that_does_not_match_its_checksum_changes_nothing(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    with made.path.open("ab") as damage:
        damage.write(b"\0")
    target = tmp_path / "live.duckdb"
    Store(target).close()
    before = target.read_bytes()

    with pytest.raises(BackupError, match="doesn't match its checksum"):
        backup.restore(made.path, target, force=True, at=AT)

    assert target.read_bytes() == before
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "backups",
        "live.duckdb",
        "ousd.duckdb",
    ]


def test_a_copy_without_its_checksum_is_refused(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    backup.checksum_path(made.path).unlink()

    with pytest.raises(BackupError, match="is missing"):
        backup.restore(made.path, tmp_path / "new.duckdb", force=False, at=AT)

    assert not (tmp_path / "new.duckdb").exists()


def test_a_malformed_checksum_is_refused(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    backup.checksum_path(made.path).write_text("not a checksum\n")

    with pytest.raises(BackupError, match="doesn't hold a sha256"):
        backup.restore(made.path, tmp_path / "new.duckdb", force=False, at=AT)


def test_a_restore_refuses_a_stale_log_without_its_database(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    target = tmp_path / "new.duckdb"
    backup.wal_path(target).write_bytes(b"stale")

    with pytest.raises(BackupError, match="without its database"):
        backup.restore(made.path, target, force=False, at=AT)

    assert not target.exists()


def test_a_forced_restore_onto_a_held_database_changes_nothing(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    target = tmp_path / "live.duckdb"
    Store(target).close()
    before = target.read_bytes()
    holder = hold(target)
    try:
        with pytest.raises(duckdb.IOException):
            backup.restore(made.path, target, force=True, at=AT)
    finally:
        holder.communicate("\n", timeout=30)

    assert target.read_bytes() == before
    assert not list(tmp_path.glob("live.duckdb.*"))


def with_checksum(path):
    """Write the .sha256 beside a file, as backup does."""
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    backup.checksum_path(path).write_text(f"{digest}  {path.name}\n")
    return path


def test_a_verified_file_that_is_not_a_database_changes_nothing(tmp_path):
    copy = tmp_path / "ousd-20261106T063005Z.duckdb"
    copy.write_bytes(b"not a database")
    with_checksum(copy)
    target = tmp_path / "live.duckdb"
    Store(target).close()
    before = target.read_bytes()

    with pytest.raises(BackupError, match="not a database DuckDB can open"):
        backup.restore(copy, target, force=True, at=AT)

    assert target.read_bytes() == before
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted(
        [copy.name, copy.name + ".sha256", "live.duckdb"]
    )


def test_a_copy_newer_than_the_code_is_refused_before_anything_changes(tmp_path):
    newer = tmp_path / "newer.duckdb"
    Store(newer).close()
    db = duckdb.connect(str(newer))
    db.execute("INSERT INTO schema_migrations (version, name) VALUES (?, 'future')", [LATEST + 1])
    db.close()
    made = backup.take(newer, tmp_path / "backups", AT)
    target = tmp_path / "live.duckdb"
    Store(target).close()
    before = target.read_bytes()

    with pytest.raises(BackupError, match="newer than this code"):
        backup.restore(made.path, target, force=True, at=AT)

    assert target.read_bytes() == before
    assert not list(tmp_path.glob("live.duckdb.*"))


def test_a_forced_restore_onto_a_damaged_database_says_to_move_it_aside(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    target = tmp_path / "live.duckdb"
    target.write_bytes(b"damaged")

    with pytest.raises(BackupError, match="move it aside, then restore without --force"):
        backup.restore(made.path, target, force=True, at=AT)

    assert target.read_bytes() == b"damaged"


def test_a_forced_restore_without_a_database_there_just_restores(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)

    restored = backup.restore(made.path, tmp_path / "new.duckdb", force=True, at=AT)

    assert restored.replaced is None
    assert transfer_count(tmp_path / "new.duckdb") == 1


def test_a_forced_restore_never_overwrites_an_earlier_replaced_file(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)
    target = tmp_path / "live.duckdb"
    Store(target).close()
    earlier = tmp_path / "live.duckdb.replaced-20261106T063005Z"
    earlier.write_bytes(b"earlier")
    before = target.read_bytes()

    with pytest.raises(BackupError, match="already exists"):
        backup.restore(made.path, target, force=True, at=AT)

    assert earlier.read_bytes() == b"earlier"
    assert target.read_bytes() == before


def test_a_restore_refuses_a_missing_copy_and_a_folder_as_the_target(raw, tmp_path):
    made = backup.take(raw, tmp_path / "backups", AT)

    with pytest.raises(BackupError, match="is not a file"):
        backup.restore(tmp_path / "missing.duckdb", tmp_path / "new.duckdb", force=False, at=AT)
    (tmp_path / "folder").mkdir()
    with pytest.raises(BackupError, match="is not a file"):
        backup.restore(made.path, tmp_path / "folder", force=True, at=AT)


def test_a_restored_copy_older_than_the_code_is_migrated_by_the_next_writer(tmp_path):
    old = tmp_path / "old.duckdb"
    db = duckdb.connect(str(old))
    db.execute(PRE_MIGRATIONS_SCHEMA)
    db.close()
    made = backup.take(old, tmp_path / "backups", AT)
    target = tmp_path / "restored.duckdb"

    restored = backup.restore(made.path, target, force=False, at=AT)

    assert restored.schema_version is None
    with pytest.raises(SchemaOutOfDate, match="ousd migrate"):
        Store(target, read_only=True)
    Store(target).close()
    Store(target, read_only=True).close()


# Through the CLI


@pytest.fixture
def env(monkeypatch, raw, tmp_path):
    monkeypatch.setenv("OUSD_DB_PATH", str(raw))
    monkeypatch.setenv("OUSD_BACKUP_DIR", str(tmp_path / "backups"))
    for name in (
        "OUSD_BACKUP_URL",
        "OUSD_BACKUP_ENDPOINT_URL",
        "OUSD_BACKUP_REGION",
        "OUSD_BACKUP_ACCESS_KEY_ID",
        "OUSD_BACKUP_SECRET_ACCESS_KEY",
        "OUSD_BACKUP_KEEP_DAILY",
        "OUSD_BACKUP_KEEP_WEEKLY",
    ):
        monkeypatch.delenv(name, raising=False)
    return tmp_path


def with_remote(monkeypatch) -> FakeS3:
    monkeypatch.setenv("OUSD_BACKUP_URL", "s3://ousd-backups/raw")
    monkeypatch.setenv("OUSD_BACKUP_ACCESS_KEY_ID", REMOTE.access_key_id)
    monkeypatch.setenv("OUSD_BACKUP_SECRET_ACCESS_KEY", REMOTE.secret_access_key)
    s3 = FakeS3()
    monkeypatch.setattr(backup, "make_client", lambda remote: s3)
    return s3


def test_backup_without_a_url_copies_locally_and_says_the_upload_was_skipped(env, capsys):
    assert cli.main(["backup"]) == 0

    out = capsys.readouterr().out
    assert "backup: " in out
    assert "upload: skipped, OUSD_BACKUP_URL is not set" in out
    assert len(list((env / "backups").glob("ousd-*.duckdb"))) == 1


def test_backup_with_a_url_uploads_and_prunes_both_places(env, monkeypatch, capsys):
    s3 = with_remote(monkeypatch)
    monkeypatch.setenv("OUSD_BACKUP_KEEP_DAILY", "1")
    monkeypatch.setenv("OUSD_BACKUP_KEEP_WEEKLY", "0")
    for name in names(AT - timedelta(days=30)):
        s3.objects["raw/" + name] = b"old"
    (env / "backups").mkdir()
    for name in names(AT - timedelta(days=30)):
        (env / "backups" / name).write_bytes(b"old")

    assert cli.main(["backup"]) == 0

    out = capsys.readouterr().out
    assert "uploaded: s3://ousd-backups/raw/ousd-" in out
    assert out.count("removed: ") == 4
    assert len([key for key in s3.objects if key.endswith(".duckdb")]) == 1
    assert len(list((env / "backups").glob("ousd-*.duckdb"))) == 1


def test_a_failed_upload_exits_one_and_keeps_the_local_copy(env, monkeypatch, capsys):
    s3 = with_remote(monkeypatch)
    s3.fail["upload_file"] = RuntimeError("down")

    assert cli.main(["backup"]) == 1

    err = capsys.readouterr().err
    assert "object storage upload failed: RuntimeError; the local copy is kept" in err
    assert len(list((env / "backups").glob("ousd-*.duckdb.sha256"))) == 1


def test_a_bad_setting_stops_backup_before_any_copy(env, monkeypatch, capsys):
    monkeypatch.setenv("OUSD_BACKUP_KEEP_DAILY", "0")

    assert cli.main(["backup"]) == 1

    assert "OUSD_BACKUP_KEEP_DAILY" in capsys.readouterr().err
    assert not (env / "backups").exists()


def test_a_backup_folder_that_cannot_be_made_exits_one_without_a_traceback(
    env, monkeypatch, capsys
):
    (env / "a-file").write_text("x")
    monkeypatch.setenv("OUSD_BACKUP_DIR", str(env / "a-file" / "backups"))

    assert cli.main(["backup"]) == 1

    assert capsys.readouterr().err.startswith("error: ")


def test_backup_without_a_database_exits_one_and_creates_none(env, monkeypatch, capsys):
    monkeypatch.setenv("OUSD_DB_PATH", str(env / "missing.duckdb"))

    assert cli.main(["backup"]) == 1

    assert "does not exist" in capsys.readouterr().err
    assert not (env / "missing.duckdb").exists()


def test_backup_of_a_held_database_exits_two_like_the_other_writers(env, raw, capsys):
    holder = hold(raw)
    try:
        assert cli.main(["backup"]) == 2
    finally:
        holder.communicate("\n", timeout=30)

    captured = capsys.readouterr()
    assert "database in use: another process holds it" in captured.err
    assert str(raw) not in captured.err


def test_restore_through_the_cli_refuses_then_replaces_with_force(env, raw, capsys):
    assert cli.main(["backup"]) == 0
    copy = next((env / "backups").glob("ousd-*.duckdb"))
    capsys.readouterr()

    assert cli.main(["restore", str(copy)]) == 1
    assert "RESTORE REFUSED" in capsys.readouterr().err

    assert cli.main(["restore", str(copy), "--force"]) == 0
    out = capsys.readouterr().out
    assert "verified: sha256 " in out
    assert "kept: the database it replaced is at " in out
    assert "migrations:" not in out


def test_restore_through_the_cli_says_an_older_copy_needs_migrating(env, monkeypatch, capsys):
    old = env / "old.duckdb"
    db = duckdb.connect(str(old))
    db.execute(PRE_MIGRATIONS_SCHEMA)
    db.close()
    made = backup.take(old, env / "backups", AT)
    monkeypatch.setenv("OUSD_DB_PATH", str(env / "restored.duckdb"))

    assert cli.main(["restore", str(made.path)]) == 0

    out = capsys.readouterr().out
    assert "the copy has no schema version (from before migrations)" in out
    assert f"this code is at {LATEST}" in out
    assert "ousd migrate" in out


def test_restore_onto_a_held_database_exits_two(env, raw, capsys):
    made = backup.take(raw, env / "backups", AT)
    holder = hold(raw)
    try:
        assert cli.main(["restore", str(made.path), "--force"]) == 2
    finally:
        holder.communicate("\n", timeout=30)

    assert "database in use" in capsys.readouterr().err


@pytest.mark.parametrize("argv", [["backup"], ["restore", "x.duckdb"]])
def test_chain_does_not_apply_to_backup_or_restore(env, argv):
    with pytest.raises(SystemExit) as raised:
        cli.main(["--chain", "tempo", *argv])

    assert raised.value.code == 2
