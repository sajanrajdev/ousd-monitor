"""The publish step, end to end over a world built by the real dbt project."""

import csv
import hashlib
import io
import json
import os
import platform
import re
import shutil
import time
from datetime import UTC, date, datetime, timedelta
from functools import partial as bind
from importlib import metadata
from pathlib import Path

import duckdb
import jsonschema
import pytest
from dbt_helpers import invoke_dbt
from ousd import checks, cli, migrations
from ousd import publish as publisher
from ousd.chains import REQUIRED_CHAINS
from ousd.publish import PublishRefused
from ousd.publish import build as publish_build
from ousd.publish import install as publish_install
from ousd.publish import provenance as publish_provenance
from ousd.store import Store
from publish_world import (
    EVERYDAY,
    HUGE,
    ISSUERS,
    NOW,
    OUSD,
    REAL_LABELS,
    RECONCILED_AT,
    ROOT,
    RUN,
    build_world,
    record_run,
    wallets,
)

JSON_FILES = (
    "manifest.json",
    "summary.json",
    "journey.json",
    "activity.json",
    "chain_roles.json",
    "reconciliation.json",
    "labels.json",
)
CSV_FILES = ("journey.csv", "activity.csv", "chain_roles.csv")
UTC_TIME = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
EVM_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
SECRET = "k3y9aZ7QwErTyUiOpAsDfGhJkLzXcVbNm"
LATER = NOW + timedelta(days=1)


@pytest.fixture(scope="module")
def full_template(tmp_path_factory):
    return build_world(tmp_path_factory.mktemp("full-world"))


@pytest.fixture(scope="module")
def partial_template(tmp_path_factory):
    return build_world(tmp_path_factory.mktemp("partial-world"), ("tempo", "ethereum"))


@pytest.fixture
def world(full_template, tmp_path):
    yield full_template.copy(tmp_path / "world")
    # Each copy holds two databases, and pytest would otherwise keep one for every test.
    shutil.rmtree(tmp_path)


@pytest.fixture
def partial(partial_template, tmp_path):
    yield partial_template.copy(tmp_path / "world")
    shutil.rmtree(tmp_path)


@pytest.fixture
def published(world):
    world.run_checks()
    return world, world.publish()


def read_json(folder: Path, name: str):
    return json.loads((folder / name).read_text())


def snapshot(folder: Path) -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in folder.iterdir()}


def stale_mark(folder: Path):
    """The sidecar a stale mark writes, or None while the dataset is current."""
    path = folder / publisher.STALE_FILE
    return json.loads(path.read_text()) if path.exists() else None


def assert_refuses_and_leaves_the_last_good_dataset(world, make_it_fail, match, **kwargs):
    """The second publish fails: the pointer doesn't move, no folder remains, every published
    file stays byte for byte, and a sidecar says stale."""
    world.run_checks()
    first = world.publish()
    before = snapshot(first)
    make_it_fail()
    with pytest.raises(PublishRefused, match=match):
        world.publish(now=NOW + timedelta(hours=1), **kwargs)
    assert os.readlink(world.out / "latest") == first.name
    assert sorted(path.name for path in world.out.iterdir()) == sorted(["latest", first.name])
    after = snapshot(first)
    assert {name: data for name, data in after.items() if name != publisher.STALE_FILE} == before
    mark = stale_mark(first)
    assert mark["stale_since"] == "2026-11-04T07:00:00Z"
    assert match in mark["stale_reason"] or re.search(match, mark["stale_reason"])
    schema = json.loads((publisher.SCHEMA_DIR / "stale.schema.json").read_text())
    jsonschema.validate(mark, schema)
    return mark


# The happy path


def test_all_passed_writes_the_folder_and_updates_latest(published):
    world, folder = published
    assert folder == world.out / "20261104T060000Z"
    assert os.readlink(world.out / "latest") == folder.name
    assert sorted(path.name for path in folder.iterdir()) == sorted(JSON_FILES + CSV_FILES)
    assert sorted(path.name for path in world.out.iterdir()) == sorted(["latest", folder.name])
    assert not world.preview_root.exists()


def test_every_file_validates_against_its_schema(published):
    _, folder = published
    for name in JSON_FILES:
        schema = json.loads(
            (publisher.SCHEMA_DIR / f"{name.removesuffix('.json')}.schema.json").read_text()
        )
        jsonschema.Draft202012Validator.check_schema(schema)
        jsonschema.validate(read_json(folder, name), schema)


def test_every_object_in_every_schema_is_closed():
    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "object" or ("properties" in node and "required" in node):
                assert node.get("additionalProperties") not in (None, True), node
            # allOf only narrows the shapes defined above it, so it defines no object of its own.
            for key, value in node.items():
                if key != "allOf":
                    walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    for path in publisher.SCHEMA_DIR.glob("*.schema.json"):
        walk(json.loads(path.read_text()))


def test_manifest_files_match_the_files_on_disk(published):
    _, folder = published
    files = read_json(folder, "manifest.json")["files"]
    assert sorted(files) == sorted(
        name for name in JSON_FILES + CSV_FILES if name != "manifest.json"
    )
    for name, entry in files.items():
        assert entry["sha256"] == hashlib.sha256((folder / name).read_bytes()).hexdigest()
    assert files["journey.json"]["rows"] == len(read_json(folder, "journey.json")["data"])
    with (folder / "activity.csv").open(newline="") as handle:
        assert files["activity.csv"]["rows"] == len(list(csv.DictReader(handle)))
    assert files["summary.json"]["rows"] == 4


def test_the_manifest_has_data_as_of_commit_and_check_results(published):
    _, folder = published
    manifest = read_json(folder, "manifest.json")
    assert manifest["dataset_version"] == "20261104T060000Z"
    assert manifest["generated_at"] == "2026-11-04T06:00:00Z"
    assert manifest["time_zone"] == "UTC"
    assert manifest["schema_version"] == 3
    assert re.fullmatch(r"[0-9a-f]{40}", manifest["git_commit"])
    assert manifest["preview"] is False
    assert manifest["notice"] is None
    assert "stale" not in manifest
    assert manifest["check_run_id"] == RUN
    assert manifest["coverage"]["data_as_of"] == dict.fromkeys(REQUIRED_CHAINS, "2026-11-03")
    assert manifest["coverage"]["last_transfer_at"]["tempo"] == "2026-11-04T01:00:00Z"
    assert [check["name"] for check in manifest["checks"]] == list(checks.CHECK_NAMES)
    assert {check["status"] for check in manifest["checks"]} == {"passed"}
    assert manifest["definitions"]["placed_days"] == 14
    assert manifest["definitions"]["placed_min_base_units"] == "1000000000000"
    assert manifest["definitions"]["journey_first_day"] == "2026-10-14"
    assert len(manifest["labels_sha256"]) == 64
    assert manifest["warnings"] == []


def test_the_manifest_records_what_built_it(published):
    world, folder = published
    provenance = read_json(folder, "manifest.json")["provenance"]
    assert provenance == {
        "tree_state": provenance["tree_state"],
        "uv_lock_sha256": hashlib.sha256((ROOT / "uv.lock").read_bytes()).hexdigest(),
        "python_version": platform.python_version(),
        "dbt_core_version": metadata.version("dbt-core"),
        "dbt_duckdb_version": metadata.version("dbt-duckdb"),
        "raw_schema_version": migrations.LATEST,
        "dbt_manifest_sha256": hashlib.sha256(
            (world.path / "target" / "manifest.json").read_bytes()
        ).hexdigest(),
    }
    assert provenance["tree_state"] in ("clean", "dirty", "unknown")


def test_a_dirty_tree_still_publishes_and_says_so(world, monkeypatch):
    """Publishing a dirty tree is allowed. Releasing one is refused by the site's release step."""
    monkeypatch.setattr(publish_build, "_git_commit", lambda: ("a" * 40, "dirty"))
    world.run_checks()
    manifest = read_json(world.publish(), "manifest.json")
    assert manifest["git_commit"] == "a" * 40
    assert manifest["provenance"]["tree_state"] == "dirty"


def test_without_the_compiled_dbt_manifest_publish_refuses(world):
    world.run_checks()
    (world.path / "target" / "manifest.json").unlink()
    with pytest.raises(PublishRefused, match="compiled dbt manifest"):
        world.publish()
    assert not world.out.exists()


def _set_invocation(path, invocation):
    built = json.loads(path.read_text())
    if invocation is None:
        del built["metadata"]["invocation_id"]
    else:
        built["metadata"]["invocation_id"] = invocation
    path.write_text(json.dumps(built))


def test_a_dbt_manifest_from_another_invocation_is_refused(world):
    world.run_checks()
    _set_invocation(world.path / "target" / "manifest.json", "another-invocation")
    with pytest.raises(PublishRefused, match="from another dbt invocation") as refused:
        world.publish()
    assert str(world.path) not in str(refused.value)
    assert not world.out.exists()


def test_a_dbt_manifest_without_its_invocation_is_refused(world):
    world.run_checks()
    _set_invocation(world.path / "target" / "manifest.json", None)
    with pytest.raises(PublishRefused, match="names no dbt invocation") as refused:
        world.publish()
    assert str(world.path) not in str(refused.value)
    assert not world.out.exists()


@pytest.mark.parametrize("name", ["manifest.json", "run_results.json"])
def test_provenance_needs_both_dbt_invocations(world, name):
    """The checks already refuse run_results without its invocation, so this asks provenance."""
    _set_invocation(world.path / "target" / name, None)
    with world.store() as store, pytest.raises(PublishRefused, match="names no dbt invocation"):
        publisher._provenance("clean", store, world.sources)


def test_without_dbt_installed_publish_refuses(world, monkeypatch):
    def missing(package):
        raise publish_provenance.metadata.PackageNotFoundError(package)

    world.run_checks()
    monkeypatch.setattr(publish_provenance.metadata, "version", missing)
    with pytest.raises(PublishRefused, match="dbt-core isn't installed"):
        world.publish()
    assert not world.out.exists()


def test_only_the_commit_may_have_an_address_shape(published):
    """The commit's exemption from the wallet-shape gate covers that one place only."""
    _, folder = published
    manifest = read_json(folder, "manifest.json")
    publisher._refuse_unsafe_dataset({"manifest.json": manifest}, {})
    manifest["check_run_id"] = manifest["git_commit"]
    with pytest.raises(PublishRefused, match=r"manifest\.json/check_run_id holds a wallet-shaped"):
        publisher._refuse_unsafe_dataset({"manifest.json": manifest}, {})


def test_without_uv_lock_publish_refuses(world, monkeypatch):
    world.run_checks()
    monkeypatch.setattr(publish_provenance, "UV_LOCK", world.path / "no-such-uv.lock")
    with pytest.raises(PublishRefused, match=r"cannot read uv\.lock"):
        world.publish()


def test_coverage_with_four_chains(published):
    _, folder = published
    coverage = read_json(folder, "manifest.json")["coverage"]
    assert coverage["chains_expected"] == list(REQUIRED_CHAINS)
    assert coverage["chains_included"] == list(REQUIRED_CHAINS)
    assert coverage["chains_missing"] == []
    assert coverage["complete"] is True


def test_a_rerun_with_the_same_data_is_byte_identical_but_for_two_fields(published):
    world, first = published
    second = world.publish(now=LATER)
    assert second != first
    one, other = snapshot(first), snapshot(second)
    assert one.keys() == other.keys()
    for name in one:
        if name != "manifest.json":
            assert one[name] == other[name], name
    left, right = json.loads(one["manifest.json"]), json.loads(other["manifest.json"])
    for manifest in (left, right):
        del manifest["generated_at"], manifest["dataset_version"]
    assert left == right


def test_amounts_above_2_53_survive_as_exact_strings(published):
    _, folder = published
    journey = read_json(folder, "journey.json")["data"]
    tempo = [row for row in journey if row["chain"] == "tempo"]
    exact = str(HUGE + 150_000_000 * OUSD)
    assert float(exact) != int(exact)
    assert tempo[-1]["total_supply"] == exact
    assert exact in (folder / "journey.csv").read_text()
    kpi = next(r for r in read_json(folder, "summary.json")["kpis"] if r["chain"] == "tempo")
    assert kpi["total_supply"] == exact


def test_every_amount_is_a_string(published):
    _, folder = published
    for name in ("journey.json", "activity.json", "chain_roles.json"):
        for row in read_json(folder, name)["data"]:
            for column, value in row.items():
                if column in publisher._AMOUNTS and value is not None:
                    assert isinstance(value, str), (name, column)


def test_rows_are_sorted_by_chain_then_day(published):
    _, folder = published
    for name in ("journey.json", "activity.json"):
        keys = [(row["chain"], row["day"]) for row in read_json(folder, name)["data"]]
        assert keys == sorted(keys)


def test_journey_starts_after_the_placed_window_and_activity_does_not(published):
    _, folder = published
    days = [row["day"] for row in read_json(folder, "journey.json")["data"]]
    assert min(days) == "2026-10-14"
    assert min(row["day"] for row in read_json(folder, "activity.json")["data"]) == "2026-09-30"


def test_csv_has_the_same_columns_and_flattens_leading_for(published):
    _, folder = published
    for name in ("journey", "activity", "chain_roles"):
        rows = read_json(folder, f"{name}.json")["data"]
        with (folder / f"{name}.csv").open(newline="") as handle:
            read = list(csv.DictReader(handle))
        assert list(read[0]) == list(rows[0])
        assert len(read) == len(rows)
    tempo = next(r for r in read if r["chain"] == "tempo")
    assert "supply" in tempo["leading_for"].split(";")


def test_leading_for_names_the_largest_share(published):
    _, folder = published
    roles = {row["chain"]: row for row in read_json(folder, "chain_roles.json")["data"]}
    assert "supply" in roles["tempo"]["leading_for"]
    assert "supply" not in roles["base"]["leading_for"]
    # No chain leads a measure nobody has any of.
    assert not any("lending_flow" in row["leading_for"] for row in roles.values())


# Refusals


def test_one_check_failed_refuses_and_the_last_good_dataset_stays_marked_stale(world):
    assert_refuses_and_leaves_the_last_good_dataset(
        world,
        lambda: (
            world.mart_sql("UPDATE mart_activity_waterfall SET fees = fees + 1"),
            world.run_checks(now=NOW),
        ),
        "volume_waterfall",
    )


def test_a_failed_check_with_nothing_published_leaves_no_folder(world):
    world.mart_sql("UPDATE mart_activity_waterfall SET fees = fees + 1")
    world.run_checks()
    with pytest.raises(PublishRefused, match="volume_waterfall"):
        world.publish()
    assert not world.out.exists()


def test_every_check_must_pass_in_the_same_run(world):
    world.run_checks(run_id="one")
    world.raw_sql("DELETE FROM check_results WHERE run_id = 'one' AND check_name = 'freshness'")
    world.run_checks(run_id="two")
    world.raw_sql("DELETE FROM check_results WHERE run_id = 'two' AND check_name = 'dbt_tests'")
    for run_id, gone in (("one", "freshness"), ("two", "dbt_tests")):
        with pytest.raises(PublishRefused, match=f"{gone} is missing"):
            world.publish(run_id=run_id)


def test_a_run_id_with_no_rows_refuses(world):
    world.run_checks()
    with pytest.raises(PublishRefused, match="no check results for run other"):
        world.publish(run_id="other")


def test_skipped_is_refused_without_allow_partial(partial):
    partial.run_checks(allow_partial=True)
    with pytest.raises(PublishRefused, match="reconciliation_gate is skipped"):
        partial.publish()
    assert not partial.out.exists()


def test_a_row_recorded_as_not_blocking_refuses(world):
    world.run_checks()
    world.raw_sql("UPDATE check_results SET blocking = false WHERE check_name = 'freshness'")
    with pytest.raises(PublishRefused, match="not blocking"):
        world.publish()


def test_a_schema_failure_refuses_with_latest_unchanged(world):
    """A float reached an amount column. Nothing may be written, not even part of a dataset."""
    world.run_checks()
    world.publish()
    world.mart_sql("ALTER TABLE mart_supply_journey ALTER total_supply TYPE DOUBLE")
    world.run_checks()
    with pytest.raises(PublishRefused, match=r"journey\.json fails its schema"):
        world.publish(now=LATER)
    assert os.readlink(world.out / "latest") == "20261104T060000Z"
    assert sorted(path.name for path in world.out.iterdir()) == ["20261104T060000Z", "latest"]


def test_nothing_is_written_before_everything_validates(world, monkeypatch):
    world.run_checks()
    real = publisher._validate
    seen = []

    def spy(name, payload):
        assert not world.out.exists(), "a file was written before validation finished"
        seen.append(name)
        real(name, payload)

    monkeypatch.setattr(publish_build, "_validate", spy)
    world.publish()
    assert sorted(seen) == sorted(JSON_FILES)


def test_a_failure_while_writing_leaves_no_half_dataset(world, monkeypatch):
    world.run_checks()
    first = world.publish()
    written = []
    real_write = Path.write_bytes

    def fail_third(self, data):
        written.append(self.name)
        if len(written) == 3:
            raise OSError("disk full")
        return real_write(self, data)

    monkeypatch.setattr(Path, "write_bytes", fail_third)
    with pytest.raises(PublishRefused, match="OSError"):
        world.publish(now=LATER)
    monkeypatch.undo()
    assert os.readlink(world.out / "latest") == first.name
    assert sorted(path.name for path in world.out.iterdir()) == sorted(["latest", first.name])


@pytest.mark.parametrize(
    "tamper",
    [
        lambda w: w.mart_sql("UPDATE mart_supply_journey SET holders = holders + 1"),
        lambda w: w.raw_sql(
            "UPDATE sync_state SET synced_through = synced_through + 1 WHERE chain = 'base'"
        ),
        lambda w: w.sources.labels.write_text(w.sources.labels.read_text() + "\n"),
        lambda w: w.sources.run_results.write_text(
            json.dumps({**json.loads(w.sources.run_results.read_text()), "elapsed_time": 1})
        ),
    ],
    ids=["marts", "raw", "labels", "dbt-record"],
)
def test_data_that_moved_after_the_checks_refuses(world, tamper):
    world.run_checks()
    tamper(world)
    with pytest.raises(PublishRefused, match="changed since these checks ran"):
        world.publish()


def test_old_results_are_not_fresh_at_publish_time(world):
    world.run_checks()
    with pytest.raises(PublishRefused, match="freshness no longer passes"):
        world.publish(now=NOW + timedelta(days=3))


def test_a_failed_run_after_the_checks_refuses(world):
    world.run_checks()
    with world.store() as store:
        record_run(store, status="fail", exit_code=1, at=RECONCILED_AT + timedelta(minutes=1))
    with pytest.raises(PublishRefused, match="reconciliation_gate no longer passes"):
        world.publish()


def test_marts_whose_reconciliation_is_not_the_gate_run_refuse(world):
    # The gate is satisfied, and the mart shows figures its run never proved.
    world.mart_sql(
        "UPDATE mart_reconciliation SET event_value = event_value - 1 "
        "WHERE kind = 'chain' AND subject = 'tempo'"
    )
    world.run_checks()
    with pytest.raises(PublishRefused, match="not from run"):
        world.publish()


@pytest.mark.parametrize(
    "tamper,word",
    [
        ("UPDATE mart_reconciliation SET passed = false WHERE subject = 'base'", "not from run"),
        ("UPDATE mart_reconciliation SET difference = 1 WHERE subject = 'base'", "not from run"),
        ("DELETE FROM mart_reconciliation WHERE subject = 'solana'", "not from run"),
        ("UPDATE mart_reconciliation SET run_id = 'other' WHERE kind = 'bridge'", "Bridge row"),
        ("UPDATE mart_reconciliation SET passed = false WHERE kind = 'bridge'", "Bridge row"),
        ("UPDATE mart_reconciliation SET difference = 1 WHERE kind = 'bridge'", "Bridge row"),
        ("DELETE FROM mart_reconciliation WHERE kind = 'bridge'", "Bridge row"),
    ],
)
def test_every_published_reconciliation_row_must_be_the_gate_run(world, tamper, word):
    world.mart_sql(tamper)
    world.run_checks()
    with pytest.raises(PublishRefused, match=word):
        world.publish()


def _without_run_id(world, migrated_at: datetime) -> None:
    """Every reconciliation as if written with no run_id, and migration 1 applied at that time.
    The world's reconciliations were checked at RECONCILED_AT."""
    world.raw_sql("UPDATE reconciliations SET run_id = NULL")
    world.raw_sql("UPDATE schema_migrations SET applied_at = ? WHERE version = 1", [migrated_at])


@pytest.mark.parametrize("filed", [True, False], ids=["run_id", "before_run_id"])
def test_a_run_that_crashed_with_the_same_figures_does_not_take_over_the_numbers(world, filed):
    if not filed:
        _without_run_id(world, RECONCILED_AT + timedelta(days=1))
    with world.store() as store:
        crashed = store.start_run("full")
        for row in store.db.execute(
            "SELECT subject, attempt, pin_height, pin_hash, transfer_count, "
            "CAST(reference_value AS VARCHAR), CAST(observed_value AS VARCHAR) "
            "FROM reconciliation_checks WHERE check_name = 'chain_supply'"
        ).fetchall():
            chain, attempt, height, pin_hash, count, reference, observed = row
            store.record_check(
                crashed,
                "chain_supply",
                chain,
                attempt,
                "pass",
                pin_height=height,
                pin_hash=pin_hash,
                transfer_count=count,
                reference_value=int(reference),
                observed_value=int(observed),
            )
        finished = store.latest_reconciliation().run_id
    world.run_checks()
    rows = read_json(world.publish(), "reconciliation.json")["data"]
    assert {row["run_id"] for row in rows} == {finished}


def test_a_chain_row_is_attributed_by_its_run_id_before_any_figure_match(world):
    # A supply check of the gate run matches tempo's figures, but its row was filed elsewhere.
    world.raw_sql("UPDATE reconciliations SET run_id = 'elsewhere' WHERE chain = 'tempo'")
    world.run_checks()
    with pytest.raises(PublishRefused, match=r"not from run .* for: tempo$"):
        world.publish()


def test_a_chain_row_filed_under_a_run_that_never_proved_its_figures_has_no_run(world):
    # Filed under the gate run, with figures that run's supply check never passed.
    world.raw_sql(
        "UPDATE reconciliations SET minted = minted + 1, onchain_supply = onchain_supply + 1 "
        "WHERE chain = 'tempo'"
    )
    world.mart_sql(
        "UPDATE mart_reconciliation SET event_value = event_value + 1, "
        "reference_value = reference_value + 1 WHERE kind = 'chain' AND subject = 'tempo'"
    )
    world.run_checks()
    with pytest.raises(PublishRefused, match=r"not from run .* for: tempo$"):
        world.publish()


def test_chain_rows_from_before_run_id_fall_back_to_their_supply_check(world):
    with world.store() as store:
        run_id = store.latest_reconciliation().run_id
    _without_run_id(world, RECONCILED_AT + timedelta(seconds=1))
    world.run_checks()
    rows = read_json(world.publish(), "reconciliation.json")["data"]
    assert {row["run_id"] for row in rows} == {run_id}
    assert all(row["in_latest_run"] is True for row in rows)


@pytest.mark.parametrize("migrated", [timedelta(0), -timedelta(seconds=1)], ids=["at", "before"])
def test_chain_rows_without_run_id_checked_after_migration_one_have_no_run(world, migrated):
    # Written once run_id existed, yet outside any run: no run proved them.
    _without_run_id(world, RECONCILED_AT + migrated)
    world.run_checks()
    with pytest.raises(PublishRefused, match="not from run"):
        world.publish()


@pytest.mark.parametrize("other", ["elsewhere", None], ids=["two_runs", "run_and_none"])
def test_a_chain_row_matching_two_differently_filed_rows_has_no_run(world, other):
    world.raw_sql(
        "INSERT INTO reconciliations SELECT checked_at, chain, block_number, minted, burned, "
        "onchain_supply, matched, ? FROM reconciliations WHERE chain = 'base'",
        [other],
    )
    world.run_checks()
    with pytest.raises(PublishRefused, match=r"not from run .* for: base$"):
        world.publish()


def test_a_chain_row_with_no_raw_row_has_no_run(world):
    world.raw_sql("DELETE FROM reconciliations WHERE chain = 'ethereum'")
    world.run_checks()
    with pytest.raises(PublishRefused, match=r"not from run .* for: ethereum$"):
        world.publish()


def test_publish_opens_the_raw_store_read_only(world, monkeypatch):
    opened = []

    def spy(path, **kwargs):
        opened.append(kwargs)
        return Store(path, **kwargs)

    world.run_checks()
    monkeypatch.setattr(publisher, "Store", spy)
    world.publish()
    assert opened == [{"read_only": True}]


def test_publish_refuses_pending_migrations_without_applying_them(published):
    world, folder = published
    world.raw_sql("DELETE FROM schema_migrations WHERE version = 1")
    with pytest.raises(publisher.PublishUnavailable, match="ousd migrate"):
        world.publish(now=LATER)
    # A schema to bring up to date says nothing about the data.
    assert stale_mark(folder) is None
    with duckdb.connect(str(world.raw), read_only=True) as raw:
        versions = raw.execute("SELECT version FROM schema_migrations").fetchall()
    assert (1,) not in versions


@pytest.mark.parametrize("fingerprints", [("a", None), ("a", "b")], ids=["missing", "two"])
def test_checks_that_describe_two_states_of_the_data_refuse(world, fingerprints):
    world.run_checks()
    world.raw_sql("UPDATE check_results SET data_fingerprint = ?", [fingerprints[0]])
    world.raw_sql(
        "UPDATE check_results SET data_fingerprint = ? WHERE check_name = 'freshness'",
        [fingerprints[1]],
    )
    with pytest.raises(PublishRefused, match="one state of the data"):
        world.publish()


def test_a_database_in_use_refuses_without_calling_anything_stale(published, monkeypatch):
    world, folder = published

    def held(*args, **kwargs):
        raise duckdb.IOException("Could not set lock on file")

    monkeypatch.setattr(publisher, "Store", held)
    with pytest.raises(publisher.PublishUnavailable, match="in use"):
        world.publish(now=LATER)
    assert stale_mark(folder) is None


def test_a_second_publish_in_the_same_second_calls_nothing_stale(published):
    world, folder = published
    with pytest.raises(publisher.PublishUnavailable, match="try again"):
        world.publish()
    assert stale_mark(folder) is None
    assert os.readlink(world.out / "latest") == folder.name


def test_missing_databases_refuse_and_are_not_created(world):
    world.run_checks()
    world.marts_file.unlink()
    with pytest.raises(PublishRefused, match="marts database does not exist"):
        world.publish()
    assert not world.marts_file.exists()
    world.raw.unlink()
    with pytest.raises(PublishRefused, match="raw database does not exist"):
        world.publish()
    assert not world.raw.exists()


def test_a_naive_clock_is_a_bug_not_a_time(published):
    world, _ = published
    with pytest.raises(ValueError, match="time zone"):
        world.publish(now=datetime(2026, 11, 5, 6, 0))


def test_a_good_publish_clears_stale(world):
    assert_refuses_and_leaves_the_last_good_dataset(
        world, lambda: world.raw_sql("DELETE FROM check_results"), "no check results"
    )
    world.run_checks()
    folder = world.publish(now=LATER)
    assert stale_mark(world.out / "latest") is None
    assert (world.out / "latest").resolve() == folder.resolve()


def test_stale_keeps_the_first_time_it_went_stale(published):
    world, folder = published
    assert publisher.mark_stale(world.out, NOW + timedelta(hours=1), "first")
    assert publisher.mark_stale(world.out, NOW + timedelta(hours=2), "second")
    assert stale_mark(folder) == {"stale_since": "2026-11-04T07:00:00Z", "stale_reason": "second"}
    manifest = read_json(folder, "manifest.json")
    for name, entry in manifest["files"].items():
        assert entry["sha256"] == hashlib.sha256((folder / name).read_bytes()).hexdigest()


def test_mark_stale_changes_no_published_file(published):
    """A published version is immutable: every file hashes the same after the mark."""
    world, folder = published

    def hashes() -> dict[str, str]:
        return {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(folder.iterdir())
        }

    before = hashes()
    assert publisher.STALE_FILE not in before
    assert publisher.mark_stale(world.out, LATER, "reason")
    after = hashes()
    assert {name: digest for name, digest in after.items() if name != publisher.STALE_FILE} == (
        before
    )
    assert sorted(set(after) - set(before)) == [publisher.STALE_FILE]


def test_mark_stale_with_nothing_published_does_nothing(tmp_path):
    assert publisher.mark_stale(tmp_path / "nothing", NOW, "reason") is False


@pytest.mark.parametrize(
    "damaged", ["not json", "", "[]", '{"stale_reason": "x"}', '{"stale_since": "bad"}']
)
def test_a_damaged_mark_is_replaced_and_the_refusal_still_stands(published, damaged):
    """A damaged stale.json would otherwise fail every later mark, and every build of the site."""
    world, folder = published
    (folder / publisher.STALE_FILE).write_text(damaged)
    with pytest.raises(PublishRefused, match="no check results") as refused:
        world.publish(run_id="other", now=LATER)
    assert "could not be marked stale" not in str(refused.value)
    assert stale_mark(folder)["stale_since"] == "2026-11-05T06:00:00Z"


def test_a_damaged_manifest_can_still_be_marked_stale(published):
    world, folder = published
    (folder / "manifest.json").write_text("not json")
    assert publisher.mark_stale(world.out, LATER, "reason")
    assert stale_mark(folder) == {"stale_since": "2026-11-05T06:00:00Z", "stale_reason": "reason"}
    assert (folder / "manifest.json").read_text() == "not json"


@pytest.mark.parametrize(
    ("stale_since", "first"),
    [(None, "2026-11-05T06:00:00Z"), ("2026-11-04T07:00:00Z", "2026-11-04T07:00:00Z")],
    ids=["current", "already-stale"],
)
def test_a_manifest_from_an_older_schema_is_marked_beside_it(published, stale_since, first):
    """A version 2 manifest held its own stale fields. It is never rewritten, and the first time it
    went stale carries over into the sidecar."""
    world, folder = published
    manifest = read_json(folder, "manifest.json")
    del manifest["provenance"]
    manifest.update(
        schema_version=2,
        stale=stale_since is not None,
        stale_since=stale_since,
        stale_reason=stale_since and "older",
    )
    (folder / "manifest.json").write_text(json.dumps(manifest))
    before = (folder / "manifest.json").read_bytes()
    assert publisher.mark_stale(world.out, LATER, "reason")
    assert (folder / "manifest.json").read_bytes() == before
    assert stale_mark(folder) == {"stale_since": first, "stale_reason": "reason"}
    assert sorted(p.name for p in folder.iterdir() if p.name.endswith(".tmp")) == []


def test_a_pointer_that_cannot_be_swapped_leaves_no_new_folder(world, monkeypatch):
    world.run_checks()
    first = world.publish()

    def refuse(*args):
        raise OSError("no")

    monkeypatch.setattr(publish_install, "_point", refuse)
    with pytest.raises(PublishRefused, match="OSError"):
        world.publish(now=LATER)
    monkeypatch.undo()
    assert os.readlink(world.out / "latest") == first.name
    assert sorted(path.name for path in world.out.iterdir()) == sorted(["latest", first.name])
    assert stale_mark(first) is not None


def test_an_interrupt_after_the_swap_keeps_the_folder_the_pointer_names(world, monkeypatch):
    world.run_checks()
    world.publish()
    real = publisher._point

    def interrupted(root, pointer, target):
        real(root, pointer, target)
        raise KeyboardInterrupt

    monkeypatch.setattr(publish_install, "_point", interrupted)
    with pytest.raises(KeyboardInterrupt):
        world.publish(now=LATER)
    assert (world.out / "latest" / "manifest.json").is_file()


# Pruning


def test_only_the_newest_folders_stay_and_latest_is_never_removed(world):
    world.run_checks()
    for offset in range(publisher.KEEP_FOLDERS + 3):
        newest = world.publish(now=NOW + timedelta(minutes=offset))
    folders = [path.name for path in world.out.iterdir() if path.name != "latest"]
    assert len(folders) == publisher.KEEP_FOLDERS
    assert newest.name in folders
    assert "20261104T060000Z" not in folders
    assert os.readlink(world.out / "latest") == newest.name


def test_pruning_keeps_latest_even_when_it_is_the_oldest(published):
    world, folder = published
    for offset in range(1, publisher.KEEP_FOLDERS + 2):
        (world.out / f"20270101T{offset:02d}0000Z").mkdir()
    publisher._prune(world.out, "latest")
    assert folder.exists()
    assert os.readlink(world.out / "latest") == folder.name


def test_pruning_clears_leftovers_and_leaves_other_folders_alone(published):
    world, _ = published
    (world.out / "20261101T000000Z.tmp").mkdir()
    (world.out / "notes").mkdir()
    publisher._prune(world.out, "latest")
    assert not (world.out / "20261101T000000Z.tmp").exists()
    assert (world.out / "notes").exists()


# The preview


def test_a_preview_cannot_be_taken_for_the_real_dataset(partial):
    partial.run_checks(allow_partial=True)
    folder = partial.publish(allow_partial=True)

    assert folder == partial.preview_root / "preview-20261104T060000Z"
    assert os.readlink(partial.preview_root / publisher.LATEST_PREVIEW) == folder.name
    # Nothing at all under the real root, and no pointer called `latest` anywhere.
    assert not partial.out.exists()
    assert not (partial.preview_root / "latest").exists()

    manifest = read_json(folder, "manifest.json")
    assert manifest["preview"] is True
    assert "never for public release" in manifest["notice"]
    assert manifest["dataset_version"] == "preview-20261104T060000Z"
    for name in JSON_FILES:
        assert read_json(folder, name).get("preview") is True, name


def test_coverage_with_two_chains(partial):
    partial.run_checks(allow_partial=True)
    folder = partial.publish(allow_partial=True)
    coverage = read_json(folder, "manifest.json")["coverage"]
    assert coverage["chains_expected"] == list(REQUIRED_CHAINS)
    assert coverage["chains_included"] == ["tempo", "ethereum"]
    assert coverage["chains_missing"] == ["base", "solana"]
    assert coverage["complete"] is False
    assert sorted(coverage["data_as_of"]) == ["ethereum", "tempo"]
    statuses = {
        check["name"]: check["status"] for check in read_json(folder, "manifest.json")["checks"]
    }
    assert statuses["reconciliation_gate"] == statuses["cross_chain_supply"] == "skipped"


def test_a_preview_verdict_states_no_facts_and_names_its_chains(partial):
    partial.run_checks(allow_partial=True)
    summary = read_json(partial.publish(allow_partial=True), "summary.json")
    verdict = summary["verdict"]
    assert verdict["scope"] == ["tempo", "ethereum"]
    assert verdict["text"].startswith("Local preview, not a finding. On Tempo and Ethereum")
    assert "all chains" not in verdict["text"].lower()
    assert verdict["facts"] == []
    assert "chains_missing" in {limit["id"] for limit in summary["known_limits"]}


def test_a_real_manifest_with_partial_coverage_fails_its_schema(partial):
    """So a site build that validates can't be handed a preview dressed as a release."""
    partial.run_checks(allow_partial=True)
    manifest = read_json(partial.publish(allow_partial=True), "manifest.json")
    schema = json.loads((publisher.SCHEMA_DIR / "manifest.schema.json").read_text())
    manifest["preview"] = False
    manifest["notice"] = None
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(manifest, schema)
    manifest["dataset_version"] = "20261104T060000Z"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(manifest, schema)


@pytest.fixture
def real_manifest(published):
    _, folder = published
    schema = json.loads((publisher.SCHEMA_DIR / "manifest.schema.json").read_text())
    manifest = read_json(folder, "manifest.json")
    jsonschema.validate(manifest, schema)
    return manifest, schema


def duplicate_check(manifest):
    manifest["checks"][1] = dict(manifest["checks"][0])


def reorder_checks(manifest):
    manifest["checks"].reverse()


def skip_a_check(manifest):
    manifest["checks"][5]["status"] = "skipped"


def no_reconciliation(manifest):
    manifest["reconciliation"] = None


def missing_a_day(manifest):
    del manifest["coverage"]["data_as_of"]["base"]


def missing_a_cursor(manifest):
    del manifest["coverage"]["synced_through"]["solana"]


def repeated_chain(manifest):
    manifest["coverage"]["chains_included"][3] = "tempo"


def missing_a_file(manifest):
    del manifest["files"]["labels.json"]


def stale_inside_the_manifest(manifest):
    manifest.update(stale=True, stale_since="2026-11-04T07:00:00Z", stale_reason="why")


def without_provenance(manifest):
    del manifest["provenance"]


def a_short_commit(manifest):
    manifest["git_commit"] = manifest["git_commit"][:12]


def a_guessed_tree_state(manifest):
    manifest["provenance"]["tree_state"] = "probably clean"


def local_time(manifest):
    manifest["generated_at"] = "2026-11-04T01:00:00-05:00"


def rpc_url_field(manifest):
    manifest["rpc_url"] = "http://example.invalid"


@pytest.mark.parametrize(
    "change",
    [
        duplicate_check,
        reorder_checks,
        skip_a_check,
        no_reconciliation,
        missing_a_day,
        missing_a_cursor,
        repeated_chain,
        missing_a_file,
        stale_inside_the_manifest,
        without_provenance,
        a_short_commit,
        a_guessed_tree_state,
        local_time,
        rpc_url_field,
    ],
)
def test_the_manifest_schema_refuses_a_release_that_breaks_its_promises(real_manifest, change):
    manifest, schema = real_manifest
    change(manifest)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(manifest, schema)


def test_a_preview_does_not_touch_the_real_dataset(world):
    world.run_checks()
    real = world.publish()
    before = snapshot(real)
    world.mart_sql("UPDATE mart_activity_waterfall SET fees = fees + 1")
    world.run_checks(allow_partial=True)
    with pytest.raises(PublishRefused):
        world.publish(allow_partial=True, now=LATER)
    assert snapshot(real) == before
    assert not world.preview_root.exists() or not list(world.preview_root.iterdir())


def test_preview_still_needs_the_checks_that_can_run(partial):
    partial.mart_sql("UPDATE mart_activity_waterfall SET fees = fees + 1 WHERE chain = 'tempo'")
    partial.run_checks(allow_partial=True)
    with pytest.raises(PublishRefused, match="volume_waterfall"):
        partial.publish(allow_partial=True)


# Labels


def test_labels_carry_how_we_know_and_no_address_column(published):
    _, folder = published
    labels = read_json(folder, "labels.json")
    assert set(labels["data"][0]) == {
        "chain",
        "entity",
        "category",
        "source_type",
        "source_url",
        "confidence",
        "date_checked",
    }
    with REAL_LABELS.open(newline="") as handle:
        named = [row for row in csv.DictReader(handle) if row["entity"]]
    assert len(labels["data"]) == len(named)
    assert all(row["entity"] for row in labels["data"])
    assert any(row["entity"] == "Bridge" and row["category"] == "issuer" for row in labels["data"])


def test_unnamed_clusters_publish_a_count_and_their_rule_and_no_address(published):
    _, folder = published
    with REAL_LABELS.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    unnamed = [row for row in rows if not row["entity"]]
    assert unnamed and {row["category"] for row in unnamed} == {"issuer_route", "exchange_linked"}
    clusters = read_json(folder, "labels.json")["unnamed_clusters"]
    assert clusters["rule_reference"] == "labels/README.md#how-unnamed-clusters-are-found"
    assert "The hub is the wallet a chain's mints go to" in clusters["rule"]
    assert sum(entry["count"] for entry in clusters["counts"]) == len(unnamed)
    for entry in clusters["counts"]:
        expected = [
            row
            for row in unnamed
            if row["chain"] == entry["chain"] and row["category"] == entry["category"]
        ]
        assert entry["count"] == len(expected)
    for name, text in text_of(folder).items():
        for row in unnamed:
            assert row["address"] not in text, name
            assert row["source_url"] == clusters["rule_reference"] or row["source_url"] not in text


def test_the_two_unnamed_rows_with_explorer_links_publish_neither(published):
    _, folder = published
    for address in (
        "0x4787ad0324a68152834f150326fe2357af8993cc",
        "0x1767c61c9ec15126de4eb02cd9a91474584a1873",
    ):
        assert address in REAL_LABELS.read_text()
        assert not [name for name, text in text_of(folder).items() if address in text]


def test_no_published_file_leads_to_the_brainstorm(published):
    _, folder = published
    assert not [name for name, text in text_of(folder).items() if "brainstorm" in text]


def test_a_label_link_can_only_be_one_a_reader_can_open_or_a_rule_here(world):
    """The site renders these as links, so the schema refuses anything else, such as script."""
    world.run_checks()
    path = world.sources.labels
    good = path.read_text()
    assert ",https://" in good
    path.write_text(good.replace(",https://", ",javascript:", 1))
    world.run_checks()
    with pytest.raises(PublishRefused, match="plain https link"):
        world.publish()


def test_the_source_legend_is_published_as_data(published):
    _, folder = published
    legend = read_json(folder, "labels.json")["source_legend"]
    assert [row["source_type"] for row in legend["source_types"]] == [
        "explorer_tag",
        "project_docs",
        "company_docs",
        "official_statement",
        "published_research",
        "onchain_metadata",
        "exchange_listing",
        "derived_rule",
    ]
    tag = legend["source_types"][0]
    assert tag["meaning"] == "A block explorer shows this name on the address"
    assert tag["how_to_check"].startswith("Open the link")
    assert legend["reading_a_label"].startswith("a named label always has a web source")


def test_a_label_source_type_missing_from_the_legend_refuses(world, tmp_path):
    readme = tmp_path / "README.md"
    text = (ROOT / "labels" / "README.md").read_text()
    readme.write_text(text.replace("| `explorer_tag` |", "| `other_kind` |"))
    world.run_checks()
    sources = checks.Sources(
        run_results=world.sources.run_results,
        labels=world.sources.labels,
        legend=readme,
        dbt_project=world.sources.dbt_project,
    )
    with pytest.raises(PublishRefused, match="not in the legend"):
        publisher.publish(RUN, world.marts_file, world.raw, world.out, now=NOW, sources=sources)


def test_a_readme_without_the_legend_refuses(world, tmp_path):
    readme = tmp_path / "README.md"
    readme.write_text("# Labels\n")
    world.run_checks()
    sources = checks.Sources(
        run_results=world.sources.run_results,
        labels=world.sources.labels,
        legend=readme,
        dbt_project=world.sources.dbt_project,
    )
    with pytest.raises(PublishRefused, match="no section"):
        publisher.publish(RUN, world.marts_file, world.raw, world.out, now=NOW, sources=sources)


def test_it_says_which_chains_lack_an_issuer_row(published):
    """Solana has route wallets, so the mart's flag is true, and still no issuer row."""
    _, folder = published
    labels = read_json(folder, "labels.json")
    assert labels["chains_without_issuer_row"] == ["solana"]
    coverage = {row["chain"]: row for row in labels["issuer_coverage"]}
    assert coverage["solana"]["has_issuer_row"] is False
    assert coverage["solana"]["issuer_route_rows"] > 0
    assert coverage["solana"]["issuer_labeled"] is True
    assert coverage["tempo"]["issuer_rows"] == 1
    manifest = read_json(folder, "manifest.json")
    assert manifest["coverage"]["chains_without_issuer_row"] == ["solana"]
    limits = {
        limit["id"]: limit["text"] for limit in read_json(folder, "summary.json")["known_limits"]
    }
    assert "Solana has no wallet labeled as the issuer" in limits["no_issuer_row"]


def test_journey_carries_issuer_labeled_per_row(world):
    world.mart_sql("UPDATE mart_supply_journey SET issuer_labeled = false WHERE chain = 'base'")
    world.run_checks()
    folder = world.publish()
    journey = read_json(folder, "journey.json")["data"]
    assert {row["issuer_labeled"] for row in journey if row["chain"] == "tempo"} == {True}
    assert {row["issuer_labeled"] for row in journey if row["chain"] == "base"} == {False}
    limits = {
        limit["id"]: limit["text"] for limit in read_json(folder, "summary.json")["known_limits"]
    }
    assert "Base has no issuer" in limits["no_issuer_label"]


# Reconciliation numbers


def test_reconciliation_numbers_carry_their_run(published):
    world, folder = published
    with world.store() as store:
        run_id = store.latest_reconciliation().run_id
    payload = read_json(folder, "reconciliation.json")
    rows = payload["data"]
    assert [(row["kind"], row["subject"]) for row in rows] == [
        ("bridge", "all_chains"),
        ("chain", "base"),
        ("chain", "ethereum"),
        ("chain", "solana"),
        ("chain", "tempo"),
    ]
    assert {row["run_id"] for row in rows} == {run_id}
    assert all(row["passed"] and row["difference"] == "0" for row in rows)
    assert all(UTC_TIME.match(row["checked_at"]) for row in rows)
    tempo = rows[-1]
    assert tempo["event_value"] == tempo["reference_value"]
    assert int(tempo["event_value"]) > HUGE
    assert all(row["in_latest_run"] is True for row in rows)
    assert payload["latest_run"] == {
        "run_id": run_id,
        "scope": "full",
        "status": "pass",
        "finished_at": "2026-11-04T05:30:00Z",
    }
    assert read_json(folder, "manifest.json")["reconciliation"] == payload["latest_run"]


def test_a_day_with_no_supply_keeps_its_volume_and_has_null_kpis(world):
    world.mart_sql("DELETE FROM mart_activity_kpis WHERE chain = 'base' AND day_utc = '2026-10-01'")
    world.run_checks()
    folder = world.publish()
    row = next(
        r
        for r in read_json(folder, "activity.json")["data"]
        if r["chain"] == "base" and r["day"] == "2026-10-01"
    )
    assert row["headline_value"] == str(EVERYDAY)
    assert row["total_supply"] is None and row["velocity_bps"] is None
    assert row["active_wallets_7d"] is None
    with (folder / "activity.csv").open(newline="") as handle:
        written = next(
            r for r in csv.DictReader(handle) if r["chain"] == "base" and r["day"] == "2026-10-01"
        )
    assert written["total_supply"] == ""


def test_a_preview_with_no_kpis_for_a_chain_leaves_that_chain_out(world):
    world.mart_sql("DELETE FROM mart_activity_kpis WHERE chain = 'base'")
    world.run_checks()
    with pytest.raises(PublishRefused, match="chains missing from the dataset: base"):
        world.publish()


def test_a_preview_says_which_numbers_are_not_from_the_latest_run(partial):
    partial.mart_sql(
        "UPDATE mart_reconciliation SET event_value = event_value - 1 WHERE subject = 'tempo'"
    )
    partial.run_checks(allow_partial=True)
    rows = read_json(partial.publish(allow_partial=True), "reconciliation.json")["data"]
    by_subject = {row["subject"]: row for row in rows}
    assert by_subject["tempo"]["run_id"] is None
    assert by_subject["tempo"]["in_latest_run"] is False
    assert by_subject["ethereum"]["in_latest_run"] is True


# Velocity


def test_both_velocity_denominators_are_published(published):
    _, folder = published
    rows = read_json(folder, "activity.json")["data"]
    newest = next(r for r in rows if r["chain"] == "ethereum" and r["day"] == "2026-11-03")
    circulating, total = int(newest["circulating_supply"]), int(newest["total_supply"])
    assert newest["velocity_bps"] == int(newest["clean_7d"]) * 10_000 // (7 * circulating)
    assert newest["headline_velocity_bps"] == int(newest["headline_7d"]) * 10_000 // (7 * total)
    # Small circulating supply makes clean velocity read higher than headline. That isn't a bug.
    assert circulating < total
    assert newest["velocity_bps"] > newest["headline_velocity_bps"]
    definitions = read_json(folder, "manifest.json")["definitions"]["velocity"]
    assert definitions["velocity_bps"]["denominator"] == "circulating_supply"
    assert definitions["headline_velocity_bps"]["denominator"] == "total_supply"
    limits = {
        limit["id"]: limit["text"] for limit in read_json(folder, "summary.json")["known_limits"]
    }
    assert "can exceed" in limits["velocity_denominators"]


def test_the_real_ethereum_velocity_figures_publish_unchanged(world):
    """33,260 against 8,912, from Ethereum on 2026-11-03. No schema cap may refuse or clip them."""
    world.mart_sql(
        "UPDATE mart_activity_kpis SET velocity_bps = 33260, headline_velocity_bps = 8912 "
        "WHERE chain = 'ethereum' AND day_utc = '2026-11-03'"
    )
    world.run_checks()
    folder = world.publish()
    row = next(
        r
        for r in read_json(folder, "activity.json")["data"]
        if r["chain"] == "ethereum" and r["day"] == "2026-11-03"
    )
    assert (row["velocity_bps"], row["headline_velocity_bps"]) == (33260, 8912)
    kpi = next(r for r in read_json(folder, "summary.json")["kpis"] if r["chain"] == "ethereum")
    assert (kpi["velocity_bps"], kpi["headline_velocity_bps"]) == (33260, 8912)
    assert "total_supply" in kpi and "circulating_supply" in kpi


# Summary and verdict


def test_the_summary_verdict_comes_from_the_published_kpis(published):
    _, folder = published
    summary = read_json(folder, "summary.json")
    verdict = summary["verdict"]
    assert verdict["state"] == "mostly_placed"
    assert verdict["scope"] == list(REQUIRED_CHAINS)
    assert verdict["text"].startswith("On Tempo, Ethereum, Base and Solana, ")
    assert verdict["as_of"] == dict.fromkeys(REQUIRED_CHAINS, "2026-11-03")
    assert verdict["facts"] and verdict["estimates"] and verdict["opinions"]
    assert summary["notice"] == "Independent. Not affiliated with Open Standard or Bridge."
    assert {limit["id"] for limit in summary["known_limits"]} >= {
        "not_an_attestation",
        "placed_is_not_intent",
        "clean_volume_counts_hops",
        "lost_transfer_can_pass",
    }
    base = next(row for row in summary["kpis"] if row["chain"] == "base")
    assert base["clean_everyday_7d"] == str(7 * EVERYDAY)
    assert base["placed_share_bps"] == int(base["placed_supply"]) * 10_000 // int(
        base["total_supply"]
    )


def test_under_seven_days_of_history_is_no_clear_statement(world):
    world.mart_sql(
        "UPDATE mart_activity_kpis SET headline_velocity_bps = NULL "
        "WHERE chain = 'solana' AND day_utc = '2026-11-03'"
    )
    world.run_checks()
    verdict = read_json(world.publish(), "summary.json")["verdict"]
    assert verdict["state"] == "no_clear_statement"
    assert "Solana has less than seven full days" in verdict["text"]


def test_a_chain_with_only_route_wallets_is_named_in_the_verdict_estimates(published):
    _, folder = published
    verdict = read_json(folder, "summary.json")["verdict"]
    assert any("Solana has no wallet labeled as the issuer" in e for e in verdict["estimates"])


def test_a_chain_with_only_route_wallets_can_make_the_verdict_unclear(world):
    """Solana's placed supply alone carries the answer here, and may be issuer inventory."""
    world.mart_sql(
        """
        UPDATE mart_supply_journey SET placed_supply = CASE chain WHEN 'solana' THEN total_supply
            ELSE total_supply * 49 // 100 - 1 END,
        total_supply = total_supply
        WHERE day_utc = '2026-11-03'
        """
    )
    world.mart_sql(
        """
        UPDATE mart_supply_journey SET total_supply = CASE chain
            WHEN 'tempo' THEN 1000000000000000 WHEN 'ethereum' THEN 1000000000000000
            WHEN 'base' THEN 1000000000000000 ELSE 300000000000000 END,
        placed_supply = CASE chain WHEN 'solana' THEN 300000000000000 ELSE 490000000000000 END
        WHERE day_utc = '2026-11-03'
        """
    )
    world.mart_sql(
        """
        UPDATE mart_activity_kpis SET total_supply = CASE chain
            WHEN 'solana' THEN 300000000000000 ELSE 1000000000000000 END
        WHERE day_utc = '2026-11-03'
        """
    )
    world.run_checks()
    verdict = read_json(world.publish(), "summary.json")["verdict"]
    assert verdict["state"] == "no_clear_statement"
    assert "Solana has no wallet labeled as the issuer" in verdict["text"]


def test_warnings_are_in_the_manifest_and_never_block(world):
    world.mart_sql(
        "UPDATE mart_supply_journey SET placed_supply = placed_supply // 2 "
        "WHERE chain = 'base' AND day_utc = '2026-11-03'"
    )
    results = world.run_checks()
    assert {result.status for result in results.values()} == {"passed"}
    folder = world.publish()
    warnings = read_json(folder, "manifest.json")["warnings"]
    assert [(w["chain"], w["metric"], w["day"]) for w in warnings] == [
        ("base", "placed_supply", "2026-11-03")
    ]
    assert warnings[0]["current"] == str(int(warnings[0]["previous"]) // 2)


# What must never reach the dataset


def text_of(folder: Path) -> dict[str, str]:
    return {path.name: path.read_text() for path in folder.iterdir()}


def test_no_wallet_address_reaches_a_published_row(published):
    """Only a label's source link may hold one, and that link has to open for a reader to check."""
    _, folder = published
    with REAL_LABELS.open(newline="") as handle:
        labels = list(csv.DictReader(handle))
    named_addresses = {row["address"].lower() for row in labels if row["entity"]}
    for name, text in text_of(folder).items():
        found = EVM_ADDRESS.findall(text)
        if name != "labels.json":
            assert found == [], name
    for row in read_json(folder, "labels.json")["data"]:
        values = {key: value for key, value in row.items() if key != "source_url"}
        assert not EVM_ADDRESS.search(json.dumps(values))
        for address in EVM_ADDRESS.findall(row["source_url"]):
            assert address.lower() in named_addresses, row


def test_no_fixture_wallet_on_any_chain_reaches_a_file(published):
    _, folder = published
    holders = [a for chain in REQUIRED_CHAINS for a in wallets(chain).values()]
    issuers = list(ISSUERS.values())
    for name, text in text_of(folder).items():
        assert not [address for address in holders if address in text], name
        if name != "labels.json":
            assert not [address for address in issuers if address in text], name


def test_no_rpc_url_or_env_value_reaches_a_file(world, monkeypatch):
    urls = {
        "BASE_RPC_URL": f"http://base.invalid/v2/{SECRET}",
        "SOLANA_RPC_URL": f"http://solana.invalid/v2/{SECRET}",
        "TEMPO_RPC_URL": f"http://tempo.invalid/?key={SECRET}",
        "ETHEREUM_RPC_URL": f"http://ethereum.invalid/{SECRET}",
    }
    for name, value in urls.items():
        monkeypatch.setenv(name, value)
    results_path = world.sources.run_results
    results = json.loads(results_path.read_text())
    # dbt's arguments are not copied wholesale, so a value put there goes no further.
    results["args"]["vars"]["rpc_url"] = urls["BASE_RPC_URL"]
    results_path.write_text(json.dumps(results))
    world.run_checks()
    folder = world.publish()
    for name, text in text_of(folder).items():
        assert SECRET not in text, name
        assert "rpc_url" not in text.lower(), name
        assert ".invalid" not in text, name


def test_a_refusal_never_stores_a_url_in_the_manifest(world, monkeypatch):
    monkeypatch.setenv("BASE_RPC_URL", f"http://base.invalid/v2/{SECRET}")
    world.run_checks()
    world.publish()

    def explode(*args, **kwargs):
        raise RuntimeError(f"failed at http://base.invalid/v2/{SECRET}")

    monkeypatch.setattr(publish_build, "mart_rows", explode)
    with pytest.raises(PublishRefused) as refused:
        world.publish(now=LATER)
    assert SECRET not in str(refused.value)
    assert SECRET not in (world.out / "latest" / "manifest.json").read_text()


# The runtime guard: one bad value refuses the whole dataset


HOLDER = "0x" + "a1" * 20
SOLANA_HOLDER = wallets("solana")["payer"]


def assert_guard_refuses(world, match, **kwargs):
    with pytest.raises(PublishRefused, match=match) as refused:
        world.publish(**kwargs)
    assert not world.out.exists() or not [
        path for path in world.out.iterdir() if path.is_dir() and path.name != "latest"
    ]
    return str(refused.value)


def edit_label(world, old, new):
    path = world.sources.labels
    text = path.read_text()
    assert old in text
    path.write_text(text.replace(old, new, 1))


@pytest.mark.parametrize(
    "value",
    [HOLDER, HOLDER.upper().replace("0X", "0x"), SOLANA_HOLDER],
    ids=["evm", "evm-upper", "base58"],
)
def test_a_wallet_in_a_check_detail_refuses_the_whole_dataset(world, value):
    world.run_checks()
    world.raw_sql(
        "UPDATE check_results SET detail = ? WHERE check_name = 'freshness'", [f"seen {value}"]
    )
    message = assert_guard_refuses(world, "wallet-shaped")
    assert "manifest.json/checks/6/detail" in message
    assert value not in message


def test_a_wallet_as_a_run_id_refuses(world):
    world.run_checks(run_id=HOLDER)
    assert_guard_refuses(world, "check_run_id", run_id=HOLDER)


@pytest.mark.parametrize("value", [HOLDER, SOLANA_HOLDER], ids=["evm", "base58"])
def test_a_wallet_in_an_entity_refuses_the_whole_dataset(world, value):
    edit_label(world, ",LI.FI Diamond,", f",Holder {value},")
    world.run_checks()
    assert value not in assert_guard_refuses(world, "doesn't look like a name")


def test_a_keyed_url_in_an_entity_refuses(world):
    edit_label(world, ",LI.FI Diamond,", f",http://rpc.invalid/v2/{SECRET},")
    world.run_checks()
    assert SECRET not in assert_guard_refuses(world, "doesn't look like a name")


def test_the_walk_still_catches_a_url_outside_an_entity(world):
    world.run_checks()
    world.raw_sql(
        "UPDATE check_results SET detail = ? WHERE check_name = 'freshness'",
        [f"read http://rpc.invalid/v2/{SECRET}"],
    )
    assert SECRET not in assert_guard_refuses(world, "holds a URL")


def test_a_provider_value_from_the_environment_refuses_even_without_a_scheme(world, monkeypatch):
    monkeypatch.setenv("BASE_RPC_URL", f"rpc.invalid/v2/{SECRET}")
    world.run_checks()
    world.raw_sql(
        "UPDATE check_results SET detail = ? WHERE check_name = 'freshness'",
        [f"read rpc.invalid/v2/{SECRET}"],
    )
    assert SECRET not in assert_guard_refuses(world, "provider URL")


def test_a_wallet_reaching_only_a_csv_refuses(world, monkeypatch):
    real = publisher._csv_bytes
    monkeypatch.setattr(
        publish_build, "_csv_bytes", lambda rows, preview: real(rows, preview) + HOLDER.encode()
    )
    world.run_checks()
    assert_guard_refuses(world, r"\.csv holds a wallet-shaped value")


def test_the_guard_also_covers_a_preview(partial):
    partial.run_checks(allow_partial=True)
    partial.raw_sql(
        "UPDATE check_results SET detail = ? WHERE check_name = 'freshness'", [f"seen {HOLDER}"]
    )
    with pytest.raises(PublishRefused, match="wallet-shaped"):
        partial.publish(allow_partial=True)
    assert not list(partial.preview_root.glob("preview-*"))


@pytest.mark.parametrize(
    "token",
    [
        "0x20c0000000000000000000006a37DA5C996874BE",
        "0x9f6F3991D525015a6F8CaF062C83b62fD3AC4436",
        "0xB2000000000000000000002fEb517dFeC7415344",
        "ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB",
    ],
    ids=["tempo", "ethereum", "base", "solana"],
)
def test_the_token_contracts_stay_allowed(world, token):
    world.run_checks()
    world.raw_sql(
        "UPDATE check_results SET detail = ? WHERE check_name = 'freshness'", [f"token {token}"]
    )
    assert world.publish().is_dir()


def test_a_hash_or_a_run_id_is_not_a_wallet():
    assert publisher._wallet_shapes("a" * 64) == []
    assert publisher._wallet_shapes("0" + "a" * 63) == []
    assert publisher._wallet_shapes("9f3a7c21d4e8b6f5a1c9e7d3b2f4a6c8") == []


LIFI = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae"
LIFI_LINK = f"https://basescan.org/address/{LIFI}"


@pytest.mark.parametrize(
    "link,word",
    [
        (f"https://basescan.org/address/{HOLDER}", "another address"),
        (f"https://basescan.org/address/{LIFI}?a=1", "plain https"),
        (f"https://basescan.org/address/{LIFI}?", "plain https"),
        (f"https://basescan.org/address/{LIFI}#code", "plain https"),
        (f"http://basescan.org/address/{LIFI}", "plain https"),
        (f"https://user:{SECRET}@basescan.org/address/{LIFI}", "plain https"),
        (f"https://rpc.provider.invalid/v2/{SECRET}", "host"),
        (f"https://basescan.org.invalid/address/{LIFI}", "host"),
        (f"https://crystalintelligence.com/address/{LIFI}", "host"),
        ("labels/README.md#how-unnamed-clusters-are-found", "plain https"),
    ],
    ids=[
        "other-address",
        "query",
        "empty-query",
        "fragment",
        "http",
        "userinfo",
        "keyed-rpc",
        "lookalike-host",
        "wrong-type-host",
        "local-path",
    ],
)
def test_a_named_label_link_must_be_a_plain_link_to_its_documented_source(world, link, word):
    edit_label(world, LIFI_LINK, link)
    world.run_checks()
    message = assert_guard_refuses(world, word)
    assert SECRET not in message
    assert HOLDER not in message


def test_a_link_may_hold_its_own_address_in_any_case(world):
    edit_label(world, LIFI_LINK, f"https://basescan.org/address/0x{LIFI[2:].upper()}")
    world.run_checks()
    assert world.publish().is_dir()


def test_a_base58_link_must_match_exactly(world):
    orca = "BqCfmajD8Z67KrVE8i4XN43vyPS9hppFAt5dPZFFaMfu"
    edit_label(world, f"pools/{orca}", f"pools/{orca.lower()}")
    world.run_checks()
    assert_guard_refuses(world, "another address")


def test_a_source_type_with_no_listed_host_refuses(world):
    edit_label(world, "LI.FI Diamond,system,explorer_tag", "LI.FI Diamond,system,company_docs")
    world.run_checks()
    assert_guard_refuses(world, "host")


BARE_HOLDER = "a1" * 20


@pytest.mark.parametrize(
    "value",
    [BARE_HOLDER, BARE_HOLDER.upper(), "aB" * 20, "01" * 20, "0A" * 20],
    ids=["lower", "upper", "mixed", "with-zeros", "upper-with-zeros"],
)
def test_a_bare_40_hex_address_in_a_detail_refuses(world, value):
    world.run_checks()
    world.raw_sql(
        "UPDATE check_results SET detail = ? WHERE check_name = 'freshness'", [f"seen {value}"]
    )
    assert value not in assert_guard_refuses(world, "wallet-shaped")


def test_a_bare_40_hex_address_in_an_entity_refuses(world):
    edit_label(world, ",LI.FI Diamond,", f",Whale {BARE_HOLDER},")
    world.run_checks()
    with pytest.raises(PublishRefused) as refused:
        world.publish()
    assert BARE_HOLDER not in str(refused.value)
    assert not [path for path in world.out.glob("2*") if path.is_dir()]


def test_a_link_holding_a_bare_address_refuses(world):
    edit_label(world, LIFI_LINK, f"https://etherscan.io/address/{BARE_HOLDER}")
    world.run_checks()
    assert_guard_refuses(world, "another address")


def test_a_link_holding_its_own_address_without_the_prefix_refuses(world):
    edit_label(world, LIFI_LINK, f"https://etherscan.io/address/{LIFI[2:]}")
    world.run_checks()
    assert_guard_refuses(world, "another address")


@pytest.mark.parametrize(
    "value,wallet",
    [
        ("9f3a7c21d4e8b6f5a1c9e7d3b2f4a6c8", False),
        ("9f3a7c21d4e8b6f5a1c9e7d3b2f4a6c81", True),
        ("9f3a7c21d4e8b6f5a1c9e7d3b2f4a6c", False),
        ("a" * 44, True),
        ("9F3A7C21D4E8B6F5A1C9E7D3B2F4A6C8", True),
        ("a" * 40 + "0" * 24, False),
        ("a" * 64, False),
    ],
    ids=["run-id", "one-longer", "one-shorter", "44-hex", "upper-32", "sha-with-zeros", "sha"],
)
def test_only_a_32_hex_identifier_is_exempt(value, wallet):
    assert bool(publisher._wallet_shapes(value)) is wallet


def test_a_real_run_id_with_no_zero_still_publishes(world):
    run_id = "9f3a7c21d4e8b6f5a1c9e7d3b2f4a6c8"
    world.run_checks(run_id=run_id)
    assert read_json(world.publish(run_id=run_id), "manifest.json")["check_run_id"] == run_id


@pytest.mark.parametrize(
    "entity",
    [
        f"rpc.provider.invalid/v2/{SECRET}",
        f"Whale rpc.provider.invalid/v2/{SECRET}",
        "rpc.provider.invalid",
        "RPC.PROVIDER.INVALID/V2/KEY",
        "provider.invalid:8545",
        "host:8545",
        "RPC/V2/KEY",
        "user@provider",
        "provider/v2/abc",
        "Name v2/abc",
        SECRET,
        f"Whale {SECRET[:14]}",
        "a?b=c",
        "Name  Two",
        "Name\tTwo",
    ],
    ids=[
        "scheme-less-url",
        "in-a-name",
        "host",
        "upper-url",
        "host-port",
        "name-port",
        "upper-path",
        "user-at",
        "path",
        "short-path",
        "token",
        "short-token",
        "query",
        "double-space",
        "tab",
    ],
)
def test_an_entity_must_look_like_a_name(world, entity):
    edit_label(world, ",LI.FI Diamond,", f",{entity},")
    world.run_checks()
    message = assert_guard_refuses(world, "doesn't look like a name")
    assert SECRET not in message
    assert SECRET[:14] not in message


@pytest.mark.parametrize(
    "entity",
    [
        "LI.FI Diamond",
        "LI.FI",
        "0x Settler",
        "Orca OUSD/USDC Whirlpool",
        "Uniswap v3 OUSD/WETH pool",
        "Sentora OUSD Yield (Morpho vault)",
        "Tempo ReceivePolicyGuard",
        "Rock & Roll's Pool-2",
    ],
)
def test_a_real_kind_of_name_is_a_name(entity):
    assert publisher._looks_like_a_name(entity)


@pytest.mark.parametrize(
    "path",
    [
        "apikey/abc",
        "APIKEY/abc",
        "api-key/abc",
        "api_key/abc",
        "myapikey",
        "access_token/abc",
        "auth-token/abc",
        "key/abc",
        "secret/abc",
        "password/abc",
        "passwd/abc",
        "credentials/abc",
        "bearer/abc",
        "jwt/abc",
        f"v2/{SECRET}",
        f"address/{SECRET[:14]}",
        "address/a1b2c3d4e5f6",
        "address/123456789012",
        "address/abcdefghijklmnopqrst",
        "address/key=abc",
        "address/%6b%65%79",
        "address/a:b",
    ],
)
def test_a_link_path_must_hold_no_key_like_segment(world, path):
    edit_label(world, LIFI_LINK, f"https://etherscan.io/{path}")
    world.run_checks()
    message = assert_guard_refuses(world, "key-like")
    assert SECRET not in message


@pytest.mark.parametrize(
    "path",
    [
        "stablecoin/ousd-stablecoin-first-week-on-chain-analysis/",
        "docs/protocols/v4/deployments",
        "developers/docs/quickstart/predeployed-contracts",
        "vaults/4217",
        "chains",
        "key-findings-of-the-report",
        "tokens",
    ],
)
def test_an_ordinary_link_path_is_not_key_like(path):
    row = {
        "chain": "base",
        "address": LIFI,
        "source_type": "explorer_tag",
        "source_url": f"https://etherscan.io/{path}",
    }
    publisher._refuse_bad_source(row, {"explorer_tag": {"etherscan.io"}})


def real_labels() -> list[dict[str, str]]:
    with REAL_LABELS.open(newline="") as handle:
        return list(csv.DictReader(handle))


REAL_NAMED = [row for row in real_labels() if row["entity"]]


@pytest.mark.parametrize(
    "row", REAL_NAMED, ids=[f"{row['chain']}-{row['address'][:10]}" for row in REAL_NAMED]
)
def test_every_real_label_passes_the_guard(row):
    """A false refusal here would stop every real publish."""
    hosts = publisher._read_source_hosts((ROOT / "labels" / "README.md").read_text())
    assert publisher._looks_like_a_name(row["entity"])
    publisher._refuse_bad_source(row, hosts)


def test_the_real_labels_payload_passes_the_whole_guard():
    readme = (ROOT / "labels" / "README.md").read_text()
    payload = publisher._labels_payload(real_labels(), readme, [], False, [])
    assert len(payload["data"]) == len(REAL_NAMED)
    publisher._refuse_unsafe_dataset({"labels.json": payload}, {})


# Thresholds come from what the build used


def edit_project(world, name, value):
    path = world.sources.dbt_project
    text, count = re.subn(rf"^(  {name}): .*$", rf"\g<1>: {value}", path.read_text(), flags=re.M)
    assert count == 1
    path.write_text(text)


def test_thresholds_changed_after_the_build_refuse_and_are_never_published(world):
    """The reported case: 20 days and $5M in the project file, over marts built on 14 and $1M."""
    edit_project(world, "placed_days", 20)
    edit_project(world, "placed_min_base_units", 5_000_000_000_000)
    results = world.run_checks()
    assert results["dbt_tests"].status == "failed"
    with pytest.raises(PublishRefused, match="dbt_tests is failed"):
        world.publish()
    assert not world.out.exists()


def test_thresholds_changed_between_check_and_publish_refuse(world):
    world.run_checks()
    edit_project(world, "placed_days", 20)
    with pytest.raises(PublishRefused, match="changed since these checks ran"):
        world.publish()


def test_definitions_come_from_the_build_even_if_the_check_is_bypassed(world):
    world.run_checks()
    edit_project(world, "placed_days", 20)
    with world.marts() as marts:
        definitions = publisher._definitions(world.sources, marts)
    assert definitions["placed_days"] == 14
    assert definitions["placed_min_base_units"] == "1000000000000"
    assert definitions["journey_first_day"] == "2026-10-14"


def test_definitions_refuse_marts_from_another_build_than_the_record(world):
    path = world.sources.run_results
    results = json.loads(path.read_text())
    results["metadata"]["invocation_id"] = "00000000-0000-0000-0000-000000000000"
    path.write_text(json.dumps(results))
    with world.marts() as marts, pytest.raises(ValueError, match="not from the build dbt recorded"):
        publisher._definitions(world.sources, marts)


def test_build_params_changed_between_check_and_publish_refuse(world):
    world.run_checks()
    world.mart_sql("UPDATE mart_build_params SET placed_days = 20")
    with pytest.raises(PublishRefused, match="changed since these checks ran"):
        world.publish()


def test_a_real_vars_build_publishes_the_values_it_used(world):
    labels = [dict(row) for row in csv.DictReader(world.sources.labels.open(newline=""))]
    result = invoke_dbt(
        world.path,
        labels,
        dbt_vars={"placed_days": 20, "placed_min_base_units": 5_000_000_000_000},
    )
    assert result.success
    results = world.run_checks()
    assert {r.status for r in results.values()} == {"passed"}, results
    folder = world.publish()
    definitions = read_json(folder, "manifest.json")["definitions"]
    assert definitions["placed_days"] == 20
    assert definitions["placed_min_base_units"] == "5000000000000"
    assert definitions["journey_first_day"] == "2026-10-20"
    text = read_json(folder, "summary.json")["verdict"]["text"]
    assert "at least 20 days in wallets of $5M" in text
    assert min(row["day"] for row in read_json(folder, "journey.json")["data"]) == "2026-10-20"


# Integers are integers


def test_a_float_in_an_integer_field_refuses_even_if_whole(world):
    world.mart_sql("ALTER TABLE mart_activity_kpis ALTER velocity_bps TYPE DOUBLE")
    world.run_checks()
    assert_guard_refuses(world, r"\.json fails its schema")


def test_a_float_count_refuses(world):
    world.mart_sql("ALTER TABLE mart_supply_journey ALTER holders TYPE DOUBLE")
    world.run_checks()
    assert_guard_refuses(world, r"journey\.json fails its schema")


def test_a_boolean_is_not_an_integer(published):
    _, folder = published
    payload = read_json(folder, "journey.json")
    payload["data"][0]["holders"] = True
    with pytest.raises(PublishRefused, match="fails its schema"):
        publisher._validate("journey.json", payload)


# A preview can't be read as real, even with every chain present


def test_a_four_chain_preview_says_so_everywhere(world):
    world.run_checks(allow_partial=True)
    folder = world.publish(allow_partial=True)
    verdict = read_json(folder, "summary.json")["verdict"]
    assert verdict["text"].startswith("Local preview, not a finding. On Tempo, Ethereum")
    assert verdict["facts"] == []
    limits = {limit["id"] for limit in read_json(folder, "summary.json")["known_limits"]}
    assert "local_preview" in limits
    for name in CSV_FILES:
        with (folder / name).open(newline="") as handle:
            rows = list(csv.DictReader(handle))
        assert rows
        assert {row["preview"] for row in rows} == {publisher.PREVIEW_CSV_MARK}, name
        assert next(iter(rows[0])) == "preview"


def test_a_real_csv_has_no_preview_column(published):
    _, folder = published
    for name in CSV_FILES:
        assert "preview" not in (folder / name).read_text().splitlines()[0]
        assert publisher.PREVIEW_CSV_MARK not in (folder / name).read_text()


def test_manifest_hashes_cover_the_marked_csv(world):
    world.run_checks(allow_partial=True)
    folder = world.publish(allow_partial=True)
    for name, entry in read_json(folder, "manifest.json")["files"].items():
        assert entry["sha256"] == hashlib.sha256((folder / name).read_bytes()).hexdigest()


# Times are UTC, in any zone


def utc_times_in(value):
    if isinstance(value, dict):
        for inner in value.values():
            yield from utc_times_in(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from utc_times_in(inner)
    elif isinstance(value, str) and re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T", value):
        yield value


@pytest.fixture(params=["Asia/Tokyo", "America/Los_Angeles"])
def far_from_utc(request, monkeypatch):
    monkeypatch.setenv("TZ", request.param)
    time.tzset()
    yield request.param
    monkeypatch.undo()
    time.tzset()


def test_published_times_are_utc_in_another_time_zone(world, far_from_utc):
    assert time.timezone != 0
    world.run_checks()
    with world.store() as store:
        # Proves this test bites: the session really is elsewhere.
        zone = store.db.execute("SELECT current_setting('TimeZone')").fetchone()
        assert zone == (far_from_utc,)
        raw = store.db.execute("SELECT checked_at FROM check_results LIMIT 1").fetchone()
        assert raw is not None and raw[0].utcoffset() != timedelta(0)
    folder = world.publish()
    assert folder.name == "20261104T060000Z"
    manifest = read_json(folder, "manifest.json")
    assert manifest["generated_at"] == "2026-11-04T06:00:00Z"
    assert {check["checked_at"] for check in manifest["checks"]} == {"2026-11-04T06:00:00Z"}
    assert manifest["reconciliation"]["finished_at"] == "2026-11-04T05:30:00Z"
    assert manifest["coverage"]["last_transfer_at"]["tempo"] == "2026-11-04T01:00:00Z"
    assert manifest["coverage"]["data_as_of"]["tempo"] == "2026-11-03"
    for name in JSON_FILES:
        times = list(utc_times_in(read_json(folder, name)))
        assert all(UTC_TIME.match(moment) for moment in times), (name, times)
    reconciliation = read_json(folder, "reconciliation.json")
    assert {row["checked_at"] for row in reconciliation["data"]} == {"2026-11-04T05:30:00Z"}


def test_a_time_zone_does_not_change_one_byte(world, tmp_path, monkeypatch):
    world.run_checks()
    utc = snapshot(world.publish())
    monkeypatch.setenv("TZ", "Asia/Kolkata")
    time.tzset()
    try:
        elsewhere = world.copy(tmp_path / "elsewhere")
        elsewhere.run_checks()
        assert snapshot(elsewhere.publish()) == utc
    finally:
        monkeypatch.undo()
        time.tzset()


def test_freshness_is_measured_in_utc_in_another_time_zone(world, far_from_utc):
    limit = RECONCILED_AT + timedelta(hours=36)
    world.raw_sql("UPDATE transfers SET block_timestamp = block_timestamp + 86400 * 30")
    assert world.run_checks(now=limit - timedelta(minutes=1))["freshness"].status == "passed"
    assert world.run_checks(now=limit + timedelta(minutes=1))["freshness"].status == "failed"


def test_mark_stale_writes_utc_in_another_time_zone(published, far_from_utc):
    world, folder = published
    publisher.mark_stale(world.out, datetime(2026, 11, 4, 16, 0, tzinfo=UTC), "reason")
    assert stale_mark(folder)["stale_since"] == "2026-11-04T16:00:00Z"


# The commands


@pytest.fixture
def commands(world, monkeypatch):
    """The real commands with a fixed clock, and with no provider key in the environment."""
    for name in ("BASE_RPC_URL", "SOLANA_RPC_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OUSD_DB_PATH", str(world.raw))
    monkeypatch.setenv("OUSD_MARTS_DB_PATH", str(world.marts_file))
    monkeypatch.setenv("OUSD_PUBLISHED_DIR", str(world.out))
    real_check, real_publish = cli.evaluate_checks, cli.publish

    def evaluate_checks(store, marts, allow_partial):
        return real_check(store, marts, allow_partial, NOW, world.sources)

    monkeypatch.setattr(cli, "evaluate_checks", evaluate_checks)
    monkeypatch.setattr(cli, "publish", bind(real_publish, now=NOW, sources=world.sources))
    return world


def test_check_then_publish_with_no_key_set(commands, capsys):
    assert cli.main(["check", "--run-id", RUN]) == 0
    printed = capsys.readouterr().out
    assert "RESULT: PASSED" in printed
    assert all(f"{name}: PASSED" in printed for name in checks.CHECK_NAMES)
    assert cli.main(["publish", "--run-id", RUN]) == 0
    assert "PUBLISHED" in capsys.readouterr().out
    assert (commands.out / "latest" / "manifest.json").is_file()


def test_a_failing_check_exits_one(commands, capsys):
    commands.mart_sql("UPDATE mart_activity_waterfall SET fees = fees + 1")
    assert cli.main(["check", "--run-id", RUN]) == 1
    printed = capsys.readouterr().out
    assert "volume_waterfall: FAILED" in printed
    assert "RESULT: FAILED" in printed


def test_publish_refusal_exits_one_and_reads_only_the_store(commands, capsys):
    """Publish was never told the check passed. With no rows it has nothing to believe."""
    assert cli.main(["publish", "--run-id", RUN]) == 1
    assert "PUBLISH REFUSED: no check results" in capsys.readouterr().out
    assert not commands.out.exists()


def test_a_check_with_no_database_does_not_create_one(commands, capsys):
    commands.raw.unlink()
    assert cli.main(["check", "--run-id", RUN]) == 1
    assert not commands.raw.exists()
    commands.marts_file.unlink()
    assert cli.main(["publish", "--run-id", RUN]) == 1
    assert not commands.raw.exists()


def test_allow_partial_on_the_command_line_writes_only_a_preview(commands, capsys):
    assert cli.main(["check", "--run-id", RUN, "--allow-partial"]) == 0
    assert cli.main(["publish", "--run-id", RUN, "--allow-partial"]) == 0
    assert "LOCAL PREVIEW, NOT A RELEASE" in capsys.readouterr().out
    assert not commands.out.exists()
    assert (commands.preview_root / "latest-preview" / "manifest.json").is_file()


def test_nothing_in_the_environment_can_turn_a_release_into_a_preview(commands, monkeypatch):
    monkeypatch.setenv("OUSD_ALLOW_PARTIAL", "1")
    assert cli.main(["check", "--run-id", RUN]) == 0
    assert cli.main(["publish", "--run-id", RUN]) == 0
    assert (commands.out / "latest").is_symlink()
    assert not commands.preview_root.exists()


def test_a_partial_check_does_not_end_in_passed(partial, monkeypatch, capsys):
    real = cli.evaluate_checks
    monkeypatch.setenv("OUSD_DB_PATH", str(partial.raw))
    monkeypatch.setenv("OUSD_MARTS_DB_PATH", str(partial.marts_file))

    def evaluate_checks(store, marts, allow_partial):
        return real(store, marts, allow_partial, NOW, partial.sources)

    monkeypatch.setattr(cli, "evaluate_checks", evaluate_checks)
    assert cli.main(["check", "--run-id", RUN, "--allow-partial"]) == 0
    printed = capsys.readouterr().out
    assert "RESULT: LOCAL PREVIEW ONLY, NOT RECONCILED" in printed
    assert "RESULT: PASSED" not in printed


def test_check_evaluates_read_only_then_records_with_one_writer_open(commands, monkeypatch):
    opened, real_evaluate = [], cli.evaluate_checks

    def spy(path, **kwargs):
        opened.append(kwargs)
        return Store(path, **kwargs)

    def evaluate(store, marts, allow_partial):
        with pytest.raises(duckdb.InvalidInputException, match="read-only"):
            store.db.execute("DELETE FROM check_results")
        return real_evaluate(store, marts, allow_partial)

    monkeypatch.setattr(cli, "Store", spy)
    monkeypatch.setattr(cli, "evaluate_checks", evaluate)
    assert cli.main(["check", "--run-id", RUN]) == 0
    assert opened == [{"read_only": True}, {}]
    with commands.store() as store:
        assert {check.status for check in store.check_results(RUN)} == {"passed"}


def test_pending_migrations_exit_two_from_both_commands_and_record_nothing(commands, capsys):
    commands.raw_sql("DELETE FROM schema_migrations WHERE version = 1")
    assert cli.main(["check", "--run-id", RUN]) == 2
    assert cli.main(["publish", "--run-id", RUN]) == 2
    assert capsys.readouterr().err.count("ousd migrate") == 2
    with duckdb.connect(str(commands.raw), read_only=True) as raw:
        assert raw.execute("SELECT count(*) FROM check_results").fetchone() == (0,)


def test_check_in_use_when_it_comes_to_record_exits_two(commands, monkeypatch, capsys):
    real = cli.Store

    def held_for_writers(path, **kwargs):
        if not kwargs.get("read_only"):
            raise duckdb.IOException("Could not set lock on file")
        return real(path, **kwargs)

    monkeypatch.setattr(cli, "Store", held_for_writers)
    assert cli.main(["check", "--run-id", RUN]) == 2
    assert "in use" in capsys.readouterr().err


def test_a_database_in_use_exits_two_from_both_commands(commands, monkeypatch, capsys):
    def held(*args, **kwargs):
        raise duckdb.IOException("Could not set lock on file")

    monkeypatch.setattr(cli, "Store", held)
    monkeypatch.setattr(publisher, "Store", held)
    assert cli.main(["check", "--run-id", RUN]) == 2
    assert cli.main(["publish", "--run-id", RUN]) == 2
    assert "in use" in capsys.readouterr().err


def test_chain_does_not_apply_to_the_new_commands(commands):
    with pytest.raises(SystemExit):
        cli.main(["--chain", "tempo", "check", "--run-id", RUN])


def test_run_id_is_required(commands):
    with pytest.raises(SystemExit):
        cli.main(["publish"])


def test_the_csv_writer_flattens_values():
    data = publisher._csv_bytes([{"a": ["x", "y"], "b": True, "c": None, "d": "1"}])
    assert list(csv.reader(io.StringIO(data.decode()))) == [
        ["a", "b", "c", "d"],
        ["x;y", "true", "", "1"],
    ]


def _holdings_tables(balance: int) -> dict[str, list[dict[str, object]]]:
    return {
        "mart_exchange_holdings": [
            {
                "chain": "base",
                "day_utc": date(2026, 11, 3),
                "entity": "Sample Exchange",
                "wallets": 2,
                "balance": balance,
            },
            {
                "chain": "base",
                "day_utc": date(2026, 11, 2),
                "entity": "Sample Exchange",
                "wallets": 1,
                "balance": 1,
            },
        ]
    }


_LISTINGS = (
    "## Exchanges that say they support OUSD\n\n"
    "| Exchange | Source | Date checked |\n|---|---|---|\n"
)
_LISTING_HOSTS = (
    "\n## Where each source lives\n\n"
    "| Exchange listing | Host |\n|---|---|\n"
    "| Coinbase | `www.coinbase.com` |\n| Kraken | `blog.kraken.com` |\n"
)
_KRAKEN = "| Kraken | https://blog.kraken.com/ousd | 2026-11-04 |\n"


def test_the_real_exchange_listings_are_published() -> None:
    readme = (ROOT / "labels" / "README.md").read_text()
    payload = publisher._labels_payload(real_labels(), readme, [], False, [])
    assert [row["entity"] for row in payload["exchange_listings"]] == ["Coinbase", "Kraken"]
    assert {row["source_type"] for row in payload["exchange_listings"]} == {"exchange_listing"}
    assert "exchange_listing" in {
        row["source_type"] for row in payload["source_legend"]["source_types"]
    }
    publisher._refuse_unsafe_dataset({"labels.json": payload}, {})


def test_an_exchange_listing_reads_its_row() -> None:
    assert publisher._read_exchange_listings(_LISTINGS + _KRAKEN + _LISTING_HOSTS) == [
        {
            "entity": "Kraken",
            "source_type": "exchange_listing",
            "source_url": "https://blog.kraken.com/ousd",
            "date_checked": "2026-11-04",
        }
    ]


@pytest.mark.parametrize(
    ("row", "match"),
    [
        ("| Kraken | blog.kraken.com/ousd | 2026-11-04 |", "can't read"),
        ("  | Kraken | https://blog.kraken.com/ousd | 2026-11-04 |", "can't read"),
        ("Kraken https://blog.kraken.com/ousd 2026-11-04", "can't read"),
        ("| Kraken | https://blog.kraken.com/ousd | soon |", "can't read"),
        ("| Kraken | https://blog.kraken.com/ousd | 2026-13-99 |", "can't read"),
        (
            "| Kraken holds the band | https://blog.kraken.com/ousd | 2026-11-04 |",
            "look like a name",
        ),
        ("| Kraken Holds Band | https://blog.kraken.com/ousd | 2026-11-04 |", "look like a name"),
        ("| John Smith | https://blog.kraken.com/ousd | 2026-11-04 |", "look like a name"),
        (
            "| https://blog.kraken.com | https://blog.kraken.com/ousd | 2026-11-04 |",
            "look like a name",
        ),
        ("| Binance | https://blog.kraken.com/ousd | 2026-11-04 |", "isn't on the list"),
        ("| Kraken | https://blog.kraken.com/ousd | 2999-01-01 |", "can't read"),
        ("| Kraken | https://www.coinbase.com/price/ousd | 2026-11-04 |", "host"),
        ("| Kraken | https://example.com/ousd | 2026-11-04 |", "host"),
        ("| Kraken | https://blog.kraken.com/ousd?a=1 | 2026-11-04 |", "plain https"),
        (f"| Kraken | https://blog.kraken.com/{LIFI} | 2026-11-04 |", "another address"),
    ],
)
def test_a_bad_exchange_listing_refuses(row: str, match: str) -> None:
    with pytest.raises(PublishRefused, match=match):
        publisher._read_exchange_listings(f"{_LISTINGS}{row}\n{_LISTING_HOSTS}")


def test_a_person_in_both_listing_tables_still_refuses() -> None:
    row = "| John Smith | https://blog.kraken.com/ousd | 2026-11-04 |\n"
    hosts = f"{_LISTING_HOSTS}| John Smith | `blog.kraken.com` |\n"
    with pytest.raises(PublishRefused, match="look like a name"):
        publisher._read_exchange_listings(f"{_LISTINGS}{row}{hosts}")


def test_a_readme_without_exchange_listings_refuses() -> None:
    with pytest.raises(PublishRefused, match="no section"):
        publisher._read_exchange_listings("## Something else\n")


def test_an_exchange_listing_with_no_table_or_no_rows_refuses() -> None:
    heading = "## Exchanges that say they support OUSD\n\n"
    with pytest.raises(PublishRefused, match="no exchange listings table"):
        publisher._read_exchange_listings(heading + _KRAKEN + _LISTING_HOSTS)
    with pytest.raises(PublishRefused, match="no exchange listings"):
        publisher._read_exchange_listings(_LISTINGS + _LISTING_HOSTS)


def test_an_exchange_listing_outside_the_table_or_listed_twice_refuses() -> None:
    heading, table = _LISTINGS.split("| Exchange")
    above = f"{heading}{_KRAKEN}\n| Exchange{table}{_KRAKEN}{_LISTING_HOSTS}"
    with pytest.raises(PublishRefused, match="can't read"):
        publisher._read_exchange_listings(above)
    with pytest.raises(PublishRefused, match="twice"):
        publisher._read_exchange_listings(f"{_LISTINGS}{_KRAKEN}{_KRAKEN}{_LISTING_HOSTS}")


def test_an_exchange_listing_with_another_labels_name_refuses() -> None:
    readme = (ROOT / "labels" / "README.md").read_text()
    labels = [
        {**row, "entity": "Kraken"} if row["category"] == "lending" and row["entity"] else row
        for row in real_labels()
    ]
    with pytest.raises(PublishRefused, match="isn't an exchange"):
        publisher._labels_payload(labels, readme, [], False, [])


def test_an_exchange_linked_label_with_a_name_refuses() -> None:
    readme = (ROOT / "labels" / "README.md").read_text()
    named = next(row for row in real_labels() if row["category"] == "exchange_linked")
    labels = [{**named, "entity": "Acme Custody"}, *real_labels()]
    with pytest.raises(PublishRefused, match=r"exchange-linked label on .* has a name"):
        publisher._labels_payload(labels, readme, [], False, [])


def test_no_real_exchange_linked_label_has_a_name() -> None:
    linked = [row for row in real_labels() if row["category"] == "exchange_linked"]
    assert linked and not any(row["entity"] for row in linked)


def test_a_wallet_label_cannot_use_a_listing_as_its_source() -> None:
    hosts = publisher._read_source_hosts((ROOT / "labels" / "README.md").read_text())
    row = {
        "chain": "base",
        "address": LIFI,
        "source_type": "exchange_listing",
        "source_url": "https://www.coinbase.com/price/ousd",
    }
    with pytest.raises(PublishRefused, match="host"):
        publisher._refuse_bad_source(row, hosts)


def test_exchange_holdings_use_the_newest_day_and_write_amounts_as_text() -> None:
    journey = [{"chain": "base", "day": "2026-11-03", "venue_exchange": "5"}]

    assert publisher._exchange_holdings(_holdings_tables(5), journey) == [
        {
            "chain": "base",
            "day": "2026-11-03",
            "entity": "Sample Exchange",
            "wallets": 2,
            "balance": "5",
        }
    ]


def test_exchange_holdings_that_miss_exchange_venues_are_refused() -> None:
    journey = [{"chain": "base", "day": "2026-11-03", "venue_exchange": "6"}]

    with pytest.raises(publisher.PublishRefused, match="exchange holdings"):
        publisher._exchange_holdings(_holdings_tables(5), journey)


# The commit, where an image has no checkout. provenance.py runs git first, so these replace it.
def _git_fails(*_args, **_kwargs):
    return publish_provenance.subprocess.CompletedProcess(
        ["git"], 128, "", "fatal: not a git repository"
    )


def _git_missing(*_args, **_kwargs):
    raise FileNotFoundError("git")


@pytest.mark.parametrize("no_git", [_git_fails, _git_missing])
def test_without_git_the_commit_comes_from_ousd_git_commit(monkeypatch, no_git):
    """Whole, and with the tree unknown, as an image has no tree to read."""
    monkeypatch.setattr(publish_provenance.subprocess, "run", no_git)
    monkeypatch.setenv("OUSD_GIT_COMMIT", "0123456789abcdef0123456789abcdef01234567")
    assert publisher._git_commit() == ("0123456789abcdef0123456789abcdef01234567", "unknown")


@pytest.mark.parametrize("no_git", [_git_fails, _git_missing])
def test_without_git_or_the_variable_publish_refuses(monkeypatch, no_git):
    monkeypatch.setattr(publish_provenance.subprocess, "run", no_git)
    monkeypatch.delenv("OUSD_GIT_COMMIT", raising=False)
    with pytest.raises(PublishRefused, match="cannot read the git commit"):
        publisher._git_commit()
    monkeypatch.setenv("OUSD_GIT_COMMIT", "")
    with pytest.raises(PublishRefused, match="cannot read the git commit"):
        publisher._git_commit()


@pytest.mark.parametrize(
    "bad",
    [
        "abc123",  # too short to trace
        "fedcba987654",  # abbreviated
        "0123456789ABCDEF",  # uppercase
        "0123456789abcdef0123456789abcdef012345678",  # 41 characters
        " 0123456789abcdef",  # padded
        "0123456789abcdef\n",
        "https://rpc.example/0123456789abcdef",
        "main",
    ],
)
def test_a_malformed_ousd_git_commit_refuses_without_echoing_it(monkeypatch, bad):
    monkeypatch.setattr(publish_provenance.subprocess, "run", _git_fails)
    monkeypatch.setenv("OUSD_GIT_COMMIT", bad)
    with pytest.raises(PublishRefused) as refused:
        publisher._git_commit()
    assert "OUSD_GIT_COMMIT isn't a full lowercase commit hash" in str(refused.value)
    assert bad.strip() not in str(refused.value)


COMMIT = "0123456789abcdef0123456789abcdef01234567"


def _git_prints(stdout, status=""):
    """git rev-parse prints stdout, and git status prints status, or fails when it is None."""

    def run(command, *_args, **_kwargs):
        if "status" in command:
            # Named, so a user's git config can't hide untracked files.
            assert "--untracked-files=normal" in command
            if status is None:
                return publish_provenance.subprocess.CompletedProcess(command, 128, "", "fatal")
            return publish_provenance.subprocess.CompletedProcess(command, 0, status, "")
        return publish_provenance.subprocess.CompletedProcess(command, 0, stdout, "")

    return run


def test_a_working_git_wins_over_the_variable(monkeypatch):
    monkeypatch.setattr(publish_provenance.subprocess, "run", _git_prints(f"{COMMIT}\n"))
    # Malformed, so a read of it would refuse: git working means it's never read.
    monkeypatch.setenv("OUSD_GIT_COMMIT", "main")
    assert publisher._git_commit() == (COMMIT, "clean")


@pytest.mark.parametrize(
    ("status", "state"),
    [
        ("", "clean"),
        (" M pipeline/ousd/publish.py\n", "dirty"),
        ("?? dbt/models/marts/new_model.sql\n", "dirty"),
        (None, "unknown"),
    ],
    ids=["clean", "changed", "untracked", "unreadable"],
)
def test_the_tree_state_is_read_never_guessed(monkeypatch, status, state):
    monkeypatch.setattr(publish_provenance.subprocess, "run", _git_prints(f"{COMMIT}\n", status))
    assert publisher._git_commit() == (COMMIT, state)


def test_a_git_status_that_hangs_leaves_the_tree_unknown(monkeypatch):
    def run(command, *args, **kwargs):
        if "status" in command:
            raise publish_provenance.subprocess.TimeoutExpired(command, 10)
        return publish_provenance.subprocess.CompletedProcess(command, 0, f"{COMMIT}\n", "")

    monkeypatch.setattr(publish_provenance.subprocess, "run", run)
    assert publisher._git_commit() == (COMMIT, "unknown")


@pytest.mark.skipif(
    shutil.which("git") is None or not (Path(__file__).parent.parent / ".git").exists(),
    reason="needs a git checkout",
)
def test_the_real_checkout_gives_a_full_hash_and_its_tree_state(monkeypatch):
    monkeypatch.setenv("OUSD_GIT_COMMIT", "f" * 40)
    commit, state = publisher._git_commit()
    assert re.fullmatch(r"[0-9a-f]{40}", commit)
    assert commit != "f" * 40
    assert state in ("clean", "dirty")


@pytest.mark.parametrize("odd", ["", f"warning: something\n{COMMIT}", "HEAD\n", "0123456789ab\n"])
def test_odd_git_output_refuses(monkeypatch, odd):
    monkeypatch.setattr(publish_provenance.subprocess, "run", _git_prints(odd))
    monkeypatch.setenv("OUSD_GIT_COMMIT", COMMIT)
    with pytest.raises(PublishRefused, match="other than a commit hash"):
        publisher._git_commit()


def test_a_hung_git_falls_back_to_the_variable(monkeypatch):
    def hang(*_args, **kwargs):
        assert kwargs["timeout"] == 10
        raise publish_provenance.subprocess.TimeoutExpired(["git"], 10)

    monkeypatch.setattr(publish_provenance.subprocess, "run", hang)
    monkeypatch.setenv("OUSD_GIT_COMMIT", COMMIT)
    assert publisher._git_commit() == (COMMIT, "unknown")


def test_a_published_manifest_carries_the_supplied_commit(world, monkeypatch):
    monkeypatch.setattr(publish_provenance.subprocess, "run", _git_fails)
    monkeypatch.setenv("OUSD_GIT_COMMIT", "fedcba9876543210fedcba9876543210fedcba98")
    world.run_checks()
    folder = world.publish()
    manifest = read_json(folder, "manifest.json")
    assert manifest["git_commit"] == "fedcba9876543210fedcba9876543210fedcba98"
    assert manifest["provenance"]["tree_state"] == "unknown"
