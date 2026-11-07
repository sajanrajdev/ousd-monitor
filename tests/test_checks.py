"""The seven blocking checks, each over a world built by the real dbt project."""

import json
import re
import shutil
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import duckdb
import pytest
from ousd import checks, sources
from ousd.chains import REQUIRED_CHAINS
from ousd.decode import ZERO_ADDRESS, Transfer
from ousd.publish import PublishRefused
from ousd.store import BalanceSample, Store
from publish_world import (
    NEWEST_TRANSFER,
    NOW,
    RECONCILED_AT,
    RUN,
    build_world,
    record_run,
    tip,
    wallets,
)


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


def edit_results(world, **fields):
    path = world.sources.run_results
    results = json.loads(path.read_text())
    results["args"].update(fields)
    path.write_text(json.dumps(results))


def test_all_seven_pass_on_good_data(world):
    results = world.run_checks()
    assert list(results) == list(checks.CHECK_NAMES)
    assert {r.status for r in results.values()} == {"passed"}, results
    assert all(r.blocking for r in results.values())


# Gate


@pytest.mark.parametrize("status,exit_code", [("fail", 1), ("unchecked", 3)])
def test_a_matched_supply_does_not_outweigh_a_run_that_did_not_pass(world, status, exit_code):
    """`reconciliations` is matched, the newest run isn't a pass, and publish refuses."""
    with world.store() as store:
        run = record_run(
            store,
            status=status,
            exit_code=exit_code,
            at=RECONCILED_AT + timedelta(minutes=1),
        )
        store.record_check(run, "same_looking", "tempo", 1, "fail", "group_not_real")
        matched = store.db.execute("SELECT bool_and(matched) FROM reconciliations").fetchone()
        assert matched == (True,)

    results = world.run_checks()
    assert results["reconciliation_gate"].status == "failed"
    assert status in results["reconciliation_gate"].detail
    # Each of these still reads a match. That is why the gate is its own check.
    assert results["chain_supply"].status == "passed"
    with pytest.raises(PublishRefused, match="reconciliation_gate"):
        world.publish()
    assert not world.out.exists()


def test_an_exit_code_of_zero_is_not_evidence_of_a_pass(world):
    world.raw_sql("UPDATE reconciliation_runs SET status = 'unchecked', exit_code = 0")
    assert world.run_checks()["reconciliation_gate"].status == "failed"
    with pytest.raises(PublishRefused):
        world.publish()


@pytest.mark.parametrize(
    "change",
    [
        "UPDATE sync_state SET synced_through = synced_through + 1 WHERE chain = 'tempo'",
        "UPDATE blocks SET block_hash = '0xother' WHERE chain = 'ethereum'",
        "DELETE FROM transfers WHERE chain = 'base' AND block_number = 300",
    ],
    ids=["cursor", "pin-hash", "transfer-count"],
)
def test_a_pass_whose_data_has_moved_fails_the_gate(world, change):
    world.raw_sql(change)
    results = world.run_checks()
    assert results["reconciliation_gate"].status == "failed"
    assert "changed since" in results["reconciliation_gate"].detail


def test_the_gate_reports_no_run(world):
    world.raw_sql("DELETE FROM reconciliation_runs")
    assert "no finished" in world.run_checks()["reconciliation_gate"].detail


# chain_supply


@pytest.mark.parametrize(
    "tamper,table",
    [
        ("UPDATE reconciliation_checks SET observed_value = observed_value + 1", "recorded"),
        ("UPDATE reconciliation_checks SET reference_value = reference_value + 1", "recorded"),
    ],
)
def test_chain_supply_fails_on_one_base_unit_recorded(world, tamper, table):
    world.raw_sql(f"{tamper} WHERE check_name = 'chain_supply' AND subject = 'tempo'")
    result = world.run_checks()["chain_supply"]
    assert result.status == "failed"
    assert table in result.detail
    assert "tempo" in result.detail


def test_chain_supply_fails_when_the_events_are_one_base_unit_off(world):
    # A mint changed after the recorded row, with the recorded row left agreeing with itself.
    world.raw_sql(
        "UPDATE transfers SET value = value + 1 WHERE chain = 'base' AND block_number = 102"
    )
    result = world.run_checks()["chain_supply"]
    assert result.status == "failed"
    assert "events give" in result.detail


def test_chain_supply_fails_if_the_newest_result_is_older_than_the_cursor(world):
    world.raw_sql(
        "UPDATE sync_state SET synced_through = synced_through + 1 WHERE chain = 'solana'"
    )
    result = world.run_checks()["chain_supply"]
    assert result.status == "failed"
    assert "cursor" in result.detail


def test_chain_supply_reads_the_newest_row_not_any_passing_row(world):
    with world.store() as store:
        store.record_check(RUN, "chain_supply", "tempo", 9, "fail", "supply_mismatch")
    assert world.run_checks()["chain_supply"].status == "failed"


@pytest.mark.parametrize("status", ["fail", "unchecked"])
def test_chain_supply_believes_the_status_even_when_the_figures_match(world, status):
    """Every other condition holds here: at the cursor, recorded figures equal, events agree."""
    world.raw_sql(
        f"UPDATE reconciliation_checks SET status = '{status}' "
        "WHERE check_name = 'chain_supply' AND subject = 'tempo'"
    )
    result = world.run_checks()["chain_supply"]
    assert result.status == "failed"
    assert result.detail == f"tempo: newest supply check is {status}"


def test_chain_supply_with_no_row_says_so(world):
    world.raw_sql("DELETE FROM reconciliation_checks WHERE subject = 'base'")
    assert world.run_checks()["chain_supply"].detail == "base: no supply check recorded"


def test_chain_supply_with_no_height_is_not_at_the_cursor(world):
    world.raw_sql(
        "UPDATE reconciliation_checks SET pin_height = NULL "
        "WHERE check_name = 'chain_supply' AND subject = 'base'"
    )
    assert "base: supply checked at None" in world.run_checks()["chain_supply"].detail


def test_chain_supply_with_no_reference_value_fails(world):
    world.raw_sql(
        "UPDATE reconciliation_checks SET reference_value = NULL, observed_value = NULL "
        "WHERE check_name = 'chain_supply' AND subject = 'base'"
    )
    assert "base: recorded None" in world.run_checks()["chain_supply"].detail


# cross_chain_supply


def test_cross_chain_passes_on_a_recorded_pass(world):
    result = world.run_checks()["cross_chain_supply"]
    assert result.status == "passed"


@pytest.mark.parametrize("status", ["fail", "unchecked"])
def test_cross_chain_fails_on_a_recorded_fail_or_unchecked(world, status):
    world.raw_sql(f"UPDATE reconciliation_checks SET status = '{status}' WHERE check_name='bridge'")
    assert world.run_checks()["cross_chain_supply"].status == "failed"


def test_cross_chain_fails_on_one_base_unit_recorded(world):
    world.raw_sql("UPDATE bridge_comparisons SET bridge_total = bridge_total + 1")
    assert world.run_checks()["cross_chain_supply"].status == "failed"


@pytest.mark.parametrize(
    "tamper",
    [
        "UPDATE bridge_comparisons SET tolerance = 1",
        "UPDATE bridge_comparisons SET passed = false",
        "UPDATE bridge_comparisons SET chains_missing = 'base'",
        "UPDATE bridge_comparisons SET chains_total = chains_total + 1",
        "UPDATE reconciliation_checks SET observed_value = observed_value + 1 "
        "WHERE check_name = 'bridge'",
        "UPDATE reconciliation_checks SET reference_value = NULL WHERE check_name = 'bridge'",
    ],
    ids=["tolerance", "passed", "chain-missing", "comparison", "check-row", "no-figure"],
)
def test_cross_chain_fails_on_any_part_of_the_record_not_matching(world, tamper):
    world.raw_sql(tamper)
    assert world.run_checks()["cross_chain_supply"].status == "failed"


def test_cross_chain_needs_the_comparison_to_be_of_the_recorded_total(world):
    # The comparison agrees with itself, but is of another total than the check recorded.
    world.raw_sql(
        "UPDATE bridge_comparisons SET chains_total = chains_total + 1, "
        "bridge_total = bridge_total + 1"
    )
    assert "does not match" in world.run_checks()["cross_chain_supply"].detail


def test_cross_chain_reads_the_final_attempt_of_the_run(world):
    with world.store() as store:
        run = store.latest_reconciliation().run_id
        store.record_check(run, "bridge", "all", 2, "unchecked", "bridge_stale")
    assert "Bridge result is unchecked" in world.run_checks()["cross_chain_supply"].detail


def test_cross_chain_reads_the_newest_finished_run_only(world):
    with world.store() as store:
        record_run(
            store,
            bridge="fail",
            status="fail",
            exit_code=1,
            at=RECONCILED_AT + timedelta(minutes=1),
        )
    assert "fail" in world.run_checks()["cross_chain_supply"].detail


def test_cross_chain_needs_this_run_to_have_compared(world):
    world.raw_sql("DELETE FROM bridge_comparisons")
    assert "no Bridge comparison" in world.run_checks()["cross_chain_supply"].detail


def test_cross_chain_never_asks_bridge(world, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("a check asked Bridge")

    monkeypatch.setattr(sources, "bridge_snapshot", refuse)
    world.raw_sql("UPDATE reconciliation_checks SET status = 'unchecked' WHERE check_name='bridge'")
    assert world.run_checks()["cross_chain_supply"].status == "failed"
    assert not hasattr(checks, "bridge_snapshot")
    assert not hasattr(checks, "RpcClient")


def test_a_missing_chain_fails_or_is_skipped_with_allow_partial(partial):
    strict = partial.run_checks()
    assert strict["cross_chain_supply"].status == "failed"
    assert strict["reconciliation_gate"].status == "failed"
    assert "base, solana" in strict["cross_chain_supply"].detail
    # Every chain is looked for, so the others say so too.
    assert strict["chain_supply"].status == "failed"

    loose = partial.run_checks(allow_partial=True)
    assert loose["cross_chain_supply"].status == "skipped"
    assert loose["reconciliation_gate"].status == "skipped"
    others = [name for name in checks.CHECK_NAMES if name not in checks.SKIPPABLE]
    assert {loose[name].status for name in others} == {"passed"}, loose


def test_a_chain_with_a_cursor_and_no_transfers_counts_as_missing(partial):
    partial.raw_sql("INSERT INTO sync_state VALUES ('base', 100)")
    with partial.store() as store:
        assert checks.present_chains(store) == ["tempo", "ethereum"]
    assert "base, solana" in partial.run_checks(allow_partial=True)["cross_chain_supply"].detail


def test_allow_partial_skips_nothing_when_no_chain_is_missing(world):
    world.raw_sql("UPDATE reconciliation_checks SET status = 'fail' WHERE check_name='bridge'")
    results = world.run_checks(allow_partial=True)
    assert results["cross_chain_supply"].status == "failed"
    assert "skipped" not in {r.status for r in results.values()}


# sampled_balances


def test_sampled_balances_fails_on_a_model_balance_off_by_one_base_unit(world):
    world.mart_sql(
        """
        UPDATE int_wallet_events SET running_balance = running_balance + 1
        WHERE chain = 'tempo' AND address = ? AND block_number = (
            SELECT max(block_number) FROM int_wallet_events
            WHERE chain = 'tempo' AND address = ?
        )
        """,
        [wallets("tempo")["payer"], wallets("tempo")["payer"]],
    )
    result = world.run_checks()["sampled_balances"]
    assert result.status == "failed"
    assert "tempo: 1 of 3" in result.detail
    assert wallets("tempo")["payer"] not in result.detail


def test_sampled_balances_fails_on_a_reading_off_by_one_base_unit(world):
    world.raw_sql(
        "UPDATE balance_samples SET observed_balance = observed_balance + 1 "
        "WHERE chain = 'solana' AND address = ?",
        [wallets("solana")["receiver"]],
    )
    assert "solana: 1 of 3" in world.run_checks()["sampled_balances"].detail


def test_sampled_balances_compares_at_the_sample_height(world):
    """A reading at an older height is the balance then, not the newest one."""
    payer = wallets("ethereum")["payer"]
    at_day_one = 200 + 1
    with world.store() as store:
        balance = store.balances_at("ethereum", [payer], at_day_one)[payer]
    world.raw_sql(
        "UPDATE balance_samples SET height = ?, model_balance = ?, observed_balance = ? "
        "WHERE chain = 'ethereum' AND address = ?",
        [at_day_one, str(balance), str(balance), payer],
    )
    assert world.run_checks()["sampled_balances"].status == "passed"


def test_sampled_balances_ignores_a_rejected_attempt_but_not_a_final_failure(world):
    with world.store() as store:
        run = store.latest_reconciliation().run_id
        chain = "base"
        store.db.execute(
            "UPDATE reconciliation_checks SET attempt = 5 WHERE run_id = ? AND subject = ? "
            "AND check_name = 'sampled_balances'",
            [run, chain],
        )
        store.db.execute(
            "UPDATE balance_samples SET attempt = 5 WHERE run_id = ? AND chain = ?", [run, chain]
        )
        store.db.execute(
            "INSERT INTO reconciliation_checks (run_id, check_name, subject, attempt, status, "
            "detail) VALUES (?, 'sampled_balances', ?, 1, 'fail', '{}')",
            [run, chain],
        )
        store.db.execute(
            "INSERT INTO balance_samples VALUES (?, ?, 1, ?, 'top', 'seed', 1, 1, 999)",
            [run, chain, wallets(chain)["payer"]],
        )
    assert world.run_checks()["sampled_balances"].status == "passed"

    world.raw_sql(
        "UPDATE reconciliation_checks SET status = 'unchecked' WHERE subject = 'base' "
        "AND check_name = 'sampled_balances' AND attempt = 5"
    )
    result = world.run_checks()["sampled_balances"]
    assert result.status == "failed"
    assert "base: sampled balances check is unchecked" in result.detail


@pytest.mark.parametrize("status", ["fail", "unchecked"])
def test_sampled_balances_believes_the_final_status_even_when_every_wallet_matches(world, status):
    world.raw_sql(
        f"UPDATE reconciliation_checks SET status = '{status}' "
        "WHERE check_name = 'sampled_balances' AND subject = 'ethereum'"
    )
    result = world.run_checks()["sampled_balances"]
    assert result.status == "failed"
    assert result.detail == f"ethereum: sampled balances check is {status}"


def test_samples_with_no_check_row_do_not_count(world):
    world.raw_sql(
        "DELETE FROM reconciliation_checks "
        "WHERE check_name = 'sampled_balances' AND subject = 'ethereum'"
    )
    assert (
        "ethereum: sampled balances check is missing"
        in world.run_checks()["sampled_balances"].detail
    )


def test_a_recheck_does_not_drop_the_wallets_that_matched_the_first_time(world):
    """A mismatch rereads only the wallets that differed. The rest keep their first reading, so a
    dbt error in one of those must still show."""
    who = wallets("tempo")
    with world.store() as store:
        run = store.latest_reconciliation().run_id
        store.db.execute(
            "UPDATE reconciliation_checks SET status = 'fail' "
            "WHERE run_id = ? AND subject = 'tempo' AND check_name = 'sampled_balances'",
            [run],
        )
        # The first read disagreed for the payer, and its recheck agreed.
        store.db.execute(
            "UPDATE balance_samples SET observed_balance = observed_balance + 5 "
            "WHERE run_id = ? AND chain = 'tempo' AND address = ?",
            [run, who["payer"]],
        )
        store.record_check(
            run,
            "sampled_balances",
            "tempo",
            2,
            "pass",
            samples=[
                BalanceSample(
                    who["payer"],
                    "recheck",
                    "seed",
                    tip("tempo"),
                    *[store.balances_at("tempo", [who["payer"]], tip("tempo"))[who["payer"]]] * 2,
                )
            ],
        )
    result = world.run_checks()["sampled_balances"]
    assert result.status == "passed", result.detail
    assert "12 wallets" in result.detail

    # The placed wallet was read only by the attempt that failed.
    world.mart_sql(
        "UPDATE int_wallet_events SET running_balance = running_balance + 1 "
        "WHERE chain = 'tempo' AND address = ?",
        [who["placed"]],
    )
    assert "tempo: 1 of 3" in world.run_checks()["sampled_balances"].detail


def test_samples_from_an_older_run_do_not_count_without_a_partial_preview(world):
    with world.store() as store:
        newest = record_run(store, at=RECONCILED_AT + timedelta(minutes=1))
        store.db.execute("DELETE FROM balance_samples WHERE run_id = ?", [newest])
    assert world.run_checks()["sampled_balances"].status == "failed"


def test_a_partial_preview_finds_a_chain_samples_in_its_newest_run_that_has_them(partial):
    with partial.store() as store:
        newest = record_run(
            store, ("tempo",), "unchecked", "partial", 3, None, RECONCILED_AT + timedelta(minutes=1)
        )
        assert newest
    results = partial.run_checks(allow_partial=True)
    assert results["sampled_balances"].status == "passed", results["sampled_balances"].detail


def test_allow_partial_with_no_chain_missing_reads_samples_from_the_gate_run_only(world):
    """A flag must not loosen a check when nothing is missing, or a real publish could use it."""
    with world.store() as store:
        newest = record_run(store, at=RECONCILED_AT + timedelta(minutes=1))
        store.db.execute("DELETE FROM balance_samples WHERE run_id = ?", [newest])
    assert world.run_checks(allow_partial=True)["sampled_balances"].status == "failed"


def test_sampled_balances_needs_samples_from_the_gate_run(world):
    world.raw_sql("DELETE FROM balance_samples WHERE chain = 'tempo'")
    result = world.run_checks()["sampled_balances"]
    assert result.status == "failed"
    assert "no samples" in result.detail


# dbt_tests


def test_dbt_tests_fails_on_any_node_that_did_not_pass(world):
    path = world.sources.run_results
    results = json.loads(path.read_text())
    results["results"][-1]["status"] = "fail"
    path.write_text(json.dumps(results))
    result = world.run_checks()["dbt_tests"]
    assert result.status == "failed"
    assert "1 dbt nodes" in result.detail


@pytest.mark.parametrize("status", ["warn", "error", "skipped", "no-op"])
def test_dbt_tests_passes_only_on_a_clean_node_status(world, status):
    path = world.sources.run_results
    results = json.loads(path.read_text())
    results["results"][0]["status"] = status
    path.write_text(json.dumps(results))
    assert world.run_checks()["dbt_tests"].status == "failed"


def test_dbt_tests_ignores_an_exposure_that_was_a_no_op(world):
    path = world.sources.run_results
    results = json.loads(path.read_text())
    results["results"].append({"unique_id": "exposure.ousd_monitor.site", "status": "no-op"})
    path.write_text(json.dumps(results))
    assert world.run_checks()["dbt_tests"].status == "passed"


@pytest.mark.parametrize("kind", ["model", "test"])
@pytest.mark.parametrize("status", ["no-op", "skipped", "error", "fail", "warn"])
def test_dbt_tests_still_fails_a_model_or_test_that_did_not_pass(world, kind, status):
    path = world.sources.run_results
    results = json.loads(path.read_text())
    results["results"].append({"unique_id": "exposure.ousd_monitor.site", "status": "no-op"})
    node = next(r for r in results["results"] if r["unique_id"].startswith(kind))
    node["status"] = status
    path.write_text(json.dumps(results))
    result = world.run_checks()["dbt_tests"]
    assert result.status == "failed"
    assert "1 dbt nodes" in result.detail


@pytest.mark.parametrize("kind,word", [("model", "no models"), ("test", "no models or no tests")])
def test_dbt_tests_needs_both_models_and_tests(world, kind, word):
    path = world.sources.run_results
    results = json.loads(path.read_text())
    results["results"] = [r for r in results["results"] if not r["unique_id"].startswith(kind)]
    path.write_text(json.dumps(results))
    assert word in world.run_checks()["dbt_tests"].detail


def test_dbt_tests_fails_with_a_row_missing_below_the_newest_block(world):
    world.raw_sql("DELETE FROM transfers WHERE chain = 'base' AND block_number = 210")
    assert "base: marts were not built" in world.run_checks()["dbt_tests"].detail


def built_with(world, **values):
    """The project file says one thing, after a build that used another."""
    path = world.sources.dbt_project
    text = path.read_text()
    for name, value in values.items():
        text, count = re.subn(rf"^(  {name}): .*$", rf"\g<1>: {value}", text, flags=re.MULTILINE)
        assert count == 1
    path.write_text(text)


@pytest.mark.parametrize(
    "name,value",
    [
        ("placed_days", 20),
        ("placed_min_base_units", 5_000_000_000_000),
        ("large_transfer_base_units", 5_000_000_000_000),
        ("clean_tx_min_base_units", 5),
        ("active_dust_base_units", 5),
        ("active_secondary_base_units", 5),
    ],
)
def test_dbt_tests_fails_when_the_project_says_other_than_the_build(world, name, value):
    built_with(world, **{name: value})
    result = world.run_checks()["dbt_tests"]
    assert result.status == "failed"
    assert f"built with other values of {name}" in result.detail


def test_dbt_tests_fails_when_vars_claim_what_the_build_did_not_compile(world):
    path = world.sources.run_results
    results = json.loads(path.read_text())
    results["args"]["vars"]["placed_days"] = 20
    path.write_text(json.dumps(results))
    assert "other values of placed_days" in world.run_checks()["dbt_tests"].detail


def test_thresholds_are_read_from_what_the_build_compiled(world):
    results = json.loads(world.sources.run_results.read_text())
    assert checks.built_thresholds(results) == {
        "placed_days": 14,
        "placed_min_base_units": 10**12,
        "large_transfer_base_units": 10**12,
        "clean_tx_min_base_units": 10**6,
        "active_dust_base_units": 10**6,
        "active_secondary_base_units": 10**8,
    }


@pytest.mark.parametrize(
    "model", ["int_wallet_placed", "mart_supply_journey", "mart_activity_waterfall"]
)
def test_a_model_that_no_longer_shows_a_threshold_fails_rather_than_guesses(world, model):
    path = world.sources.run_results
    results = json.loads(path.read_text())
    for node in results["results"]:
        if node["unique_id"].endswith(f".{model}"):
            node["compiled_code"] = "select 1"
    path.write_text(json.dumps(results))
    assert "does not show one value" in world.run_checks()["dbt_tests"].detail


def test_two_values_of_one_threshold_are_not_read_as_either(world):
    path = world.sources.run_results
    results = json.loads(path.read_text())
    for node in results["results"]:
        if node["unique_id"].endswith(".mart_supply_journey"):
            node["compiled_code"] += "\nwhere still_value >= 7"
    path.write_text(json.dumps(results))
    assert (
        "does not show one value of placed_min_base_units" in world.run_checks()["dbt_tests"].detail
    )


def test_dbt_tests_fails_with_no_record_of_a_build(world):
    world.sources.run_results.unlink()
    assert "run_results" in world.run_checks()["dbt_tests"].detail


@pytest.mark.parametrize(
    "fields,word",
    [
        ({"which": "run"}, "not build"),
        ({"select": ["mart_chain_roles"]}, "narrowed by select"),
        ({"exclude_resource_types": ["test"]}, "narrowed by exclude_resource_types"),
    ],
)
def test_dbt_tests_fails_on_a_build_of_less_than_the_project(world, fields, word):
    """Such a build exits 0, which is why the exit status can't decide this."""
    edit_results(world, **fields)
    assert word in world.run_checks()["dbt_tests"].detail


def test_dbt_tests_fails_on_marts_older_than_the_stored_transfers(world):
    transfer = Transfer(
        tip("tempo"),
        f"0xhash{tip('tempo')}",
        1,
        "0xnew",
        0,
        ZERO_ADDRESS,
        wallets("tempo")["payer"],
        1,
    )
    with world.store() as store:
        store.write_range("tempo", [transfer], {}, tip("tempo"))
    result = world.run_checks()["dbt_tests"]
    assert result.status == "failed"
    assert "tempo: marts were not built" in result.detail


def test_dbt_tests_fails_on_marts_built_from_other_labels(world):
    path = world.sources.labels
    issuer = ",Bridge,issuer,"
    assert issuer in path.read_text()
    path.write_text(path.read_text().replace(issuer, ",Bridge,dex,"))
    assert "different labels file" in world.run_checks()["dbt_tests"].detail


# volume_waterfall


@pytest.mark.parametrize(
    "column", ["clean_everyday", "headline_value", "dex_flow", "same_tx_netting"]
)
def test_volume_waterfall_fails_on_one_base_unit(world, column):
    world.mart_sql(
        f"UPDATE mart_activity_waterfall SET {column} = {column} + 1 "
        "WHERE chain = 'ethereum' AND day_utc = '2026-11-03'"
    )
    result = world.run_checks()["volume_waterfall"]
    assert result.status == "failed"
    assert result.detail == "ethereum: 1 of 35 days do not add up, first 2026-11-03"


def test_volume_waterfall_fails_on_a_chain_with_no_rows(world):
    world.mart_sql("DELETE FROM mart_activity_waterfall WHERE chain = 'base'")
    assert "base: no waterfall rows" in world.run_checks()["volume_waterfall"].detail


# freshness


def test_freshness_on_a_fake_clock_for_a_transfer(world):
    world.raw_sql("UPDATE reconciliation_checks SET recorded_at = ?", [NOW + timedelta(hours=40)])
    limit = NEWEST_TRANSFER + timedelta(hours=36)
    fresh = world.run_checks(now=limit - timedelta(minutes=1))
    assert fresh["freshness"].status == "passed"
    stale = world.run_checks(now=limit + timedelta(minutes=1))["freshness"]
    assert stale.status == "failed"
    assert "newest transfer" in stale.detail


def test_freshness_on_a_fake_clock_for_a_reconciliation(world):
    # Move every transfer forward, so only the reconciliation can be old.
    world.raw_sql("UPDATE transfers SET block_timestamp = block_timestamp + 86400 * 30")
    limit = RECONCILED_AT + timedelta(hours=36)
    assert world.run_checks(now=limit - timedelta(minutes=1))["freshness"].status == "passed"
    stale = world.run_checks(now=limit + timedelta(minutes=1))["freshness"]
    assert stale.status == "failed"
    assert "newest reconciliation" in stale.detail


def test_a_run_that_never_finished_is_not_a_fresh_reconciliation(world):
    world.raw_sql("UPDATE transfers SET block_timestamp = block_timestamp + 86400 * 30")
    with world.store() as store:
        crashed = store.start_run("full")
        store.record_check(crashed, "chain_supply", "tempo", 1, "pass", pin_height=1)
    late = RECONCILED_AT + timedelta(hours=37)
    world.raw_sql(
        "UPDATE reconciliation_checks SET recorded_at = ? WHERE run_id = ?",
        [late, crashed],
    )
    stale = world.run_checks(now=late)["freshness"]
    assert stale.status == "failed"
    assert "tempo: newest reconciliation" in stale.detail


def test_freshness_fails_a_chain_with_no_transfers(world):
    world.raw_sql("DELETE FROM transfers WHERE chain = 'base'")
    assert "base: no transfers" in world.run_checks()["freshness"].detail


# run_checks


def test_run_checks_writes_one_row_per_check_and_a_rerun_replaces_them(world):
    world.run_checks()
    with world.store() as store:
        first = store.check_results(RUN)
    assert sorted(row.check_name for row in first) == sorted(checks.CHECK_NAMES)
    assert all(row.status == "passed" and row.blocking for row in first)

    world.mart_sql("UPDATE mart_activity_waterfall SET fees = fees + 1 WHERE chain = 'tempo'")
    world.run_checks(now=NOW + timedelta(minutes=1))
    with world.store() as store:
        second = {row.check_name: row for row in store.check_results(RUN)}
        count = store.db.execute(
            "SELECT count(*) FROM check_results WHERE run_id = ?", [RUN]
        ).fetchone()
    assert count == (7,)
    assert second["volume_waterfall"].status == "failed"
    assert second["volume_waterfall"].checked_at == (NOW + timedelta(minutes=1)).replace(
        tzinfo=None
    )


def test_a_rerun_removes_a_row_no_longer_written(world):
    world.raw_sql(
        "INSERT INTO check_results (run_id, check_name, status, blocking, detail) "
        "VALUES (?, 'an_old_check', 'failed', true, 'gone')",
        [RUN],
    )
    world.run_checks()
    with world.store() as store:
        assert "an_old_check" not in {row.check_name for row in store.check_results(RUN)}


def test_a_check_that_cannot_run_has_failed_and_the_rest_still_record(world):
    world.mart_sql("DROP TABLE mart_activity_waterfall")
    results = world.run_checks()
    assert results["volume_waterfall"].status == "failed"
    assert results["volume_waterfall"].detail == "could not run: CatalogException"
    assert results["chain_supply"].status == "passed"
    with world.store() as store:
        assert len(store.check_results(RUN)) == 7
        # The marts can't be read whole, so nothing can be said to have been checked.
        assert store.check_results(RUN)[0].data_fingerprint is None


def test_no_chain_with_data_fails_every_check(tmp_path):
    store = Store(tmp_path / "empty.duckdb")
    marts = duckdb.connect(":memory:")
    try:
        results = checks.run_checks(
            store, marts, RUN, allow_partial=True, now=NOW, sources=checks.Sources()
        )
    finally:
        marts.close()
        store.close()
    assert {result.status for result in results} == {"failed"}


def test_only_the_named_two_may_be_skipped():
    statuses = dict.fromkeys(checks.CHECK_NAMES, "passed")
    assert checks.unacceptable(statuses) == []
    skipped = {**statuses, "reconciliation_gate": "skipped", "cross_chain_supply": "skipped"}
    assert len(checks.unacceptable(skipped)) == 2
    assert checks.unacceptable(skipped, allow_partial=True) == []
    assert checks.unacceptable({**statuses, "freshness": "skipped"}, allow_partial=True)
    assert checks.unacceptable({}, allow_partial=True)


# Warnings


def test_warnings_cover_each_threshold(world):
    world.mart_sql(
        "UPDATE mart_supply_journey SET total_supply = total_supply * 2 "
        "WHERE chain = 'tempo' AND day_utc = '2026-11-03'"
    )
    world.mart_sql(
        "UPDATE mart_activity_kpis SET clean_everyday_7d = clean_everyday_7d * 3 "
        "WHERE chain = 'base' AND day_utc = '2026-11-03'"
    )
    with world.marts() as marts:
        found = checks.data_warnings(marts, REQUIRED_CHAINS)
    assert {(w.chain, w.metric) for w in found} == {
        ("tempo", "total_supply"),
        ("base", "clean_everyday_7d"),
    }
    assert all(w.day.isoformat() == "2026-11-03" for w in found)


@pytest.mark.parametrize(
    "metric,table,factor,warns",
    [
        ("clean_everyday_7d", "mart_activity_kpis", "3 // 2", False),
        ("clean_everyday_7d", "mart_activity_kpis", "2 + 1", True),
        ("circulating_supply", "mart_activity_kpis", "3 // 2", True),
        ("placed_supply", "mart_supply_journey", "3 // 2", True),
    ],
    ids=["everyday-50", "everyday-over-100", "circulating", "placed"],
)
def test_each_metric_has_its_own_warning_threshold(world, metric, table, factor, warns):
    world.mart_sql(
        f"UPDATE {table} SET {metric} = {metric} * {factor} "
        "WHERE chain = 'base' AND day_utc = '2026-11-03'"
    )
    with world.marts() as marts:
        found = {w.metric for w in checks.data_warnings(marts, ["base"])}
    assert (metric in found) is warns


def test_a_change_at_the_threshold_does_not_warn(world):
    with world.marts() as marts:
        assert checks.data_warnings(marts, REQUIRED_CHAINS) == []
    assert not checks._change_is_large(100, 125, 25)
    assert checks._change_is_large(100, 126, 25)
    assert checks._change_is_large(100, 74, 25)
    assert not checks._change_is_large(0, 0, 25)
    assert checks._change_is_large(0, 1, 25)


# Times


def test_a_naive_clock_is_refused_rather_than_read_as_local(world):
    with world.store() as store, world.marts() as marts, pytest.raises(ValueError, match="zone"):
        checks.run_checks(store, marts, RUN, now=datetime(2026, 11, 4, 6, 0))


def test_utc_text_says_utc_whatever_it_is_given():
    tokyo = datetime(2026, 11, 4, 15, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
    assert checks.utc_text(tokyo) == "2026-11-04T06:00:00Z"
    assert checks.utc_text(datetime(2026, 11, 4, 6, 0)) == "2026-11-04T06:00:00Z"
