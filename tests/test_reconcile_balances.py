import time
from datetime import UTC, datetime

import pytest
from conftest import ALICE, BOB
from ousd.decode import ZERO_ADDRESS
from ousd.reconcile import BalanceFinding, BalanceRead, ChainUnavailable, Unchecked, choose_sample
from ousd.store import StoreConflict
from reconcile_fakes import (
    BAD,
    CAROL,
    LARGE,
    TX,
    BridgeFeed,
    Drift,
    FakeProbe,
    audit,
    check_detail,
    checks,
    four_probes,
    good_at,
    newest_run_checks,
    off_by,
    only_the_first_read_moves_the_cursor,
    proof_of,
    run_it,
    runs,
    same_transaction,
    slot_probes,
    stored_check_text,
    tempo_probes,
)

# The census


def census_probes(store):
    probes = four_probes(store)
    probes[1].needs_census = True
    return probes


def test_a_required_census_never_completed_is_unchecked(store):
    result, _ = run_it(store, census_probes(store))

    assert result.chains == {
        "tempo": "pass",
        "ethereum": "unchecked",
        "base": "pass",
        "solana": "pass",
    }
    assert (result.status, result.exit_code) == ("unchecked", 3)
    assert checks(store, "balance_census", "ethereum") == [(1, "unchecked", "census_missing")]
    assert checks(store, "chain_supply", "ethereum") == [(1, "pass", None)]
    assert checks(store, "bridge", "all") == [(1, "unchecked", "chains_not_passed")]


def test_a_partial_census_does_not_count(store):
    earlier = store.start_run("partial")
    store.record_check(earlier, "balance_census", "ethereum", 1, "unchecked", "census_missing")
    store.finish_run(earlier, "unchecked", 3)

    result, _ = run_it(store, census_probes(store))

    assert result.chains["ethereum"] == "unchecked"
    assert result.exit_code == 3


def test_a_completed_census_counts_and_records_no_new_row(store):
    earlier = store.start_run("partial")
    store.record_check(earlier, "balance_census", "ethereum", 1, "pass")
    store.finish_run(earlier, "unchecked", 3)

    result, _ = run_it(store, census_probes(store))

    assert (result.chains["ethereum"], result.exit_code) == ("pass", 0)
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None)]
    assert store.latest_reconciliation().usable


def test_a_supply_fail_outranks_a_missing_census(store):
    probes = census_probes(store)
    probes[1].steps = [Drift(1), Drift(1)]

    result, _ = run_it(store, probes)

    assert (result.chains["ethereum"], result.exit_code) == ("fail", 1)
    assert checks(store, "balance_census", "ethereum") == [(1, "unchecked", "census_missing")]


def test_a_missing_census_is_still_recorded_when_the_chain_cannot_be_read(store):
    probes = census_probes(store)
    probes[1].steps = [ChainUnavailable("sync_failed")]

    result, _ = run_it(store, probes)

    assert result.chains["ethereum"] == "unchecked"
    assert checks(store, "chain_supply", "ethereum") == [(1, "unchecked", "sync_failed")]
    assert checks(store, "balance_census", "ethereum") == [(1, "unchecked", "census_missing")]


# The sample. See "Sampled balances" in the reconciliation plan.

DAY = "2026-11-04"
DAN = "0x" + "e" * 40


def wallet(number):
    return f"0x{number:040x}"


WALLETS = [wallet(number) for number in range(1, 101)]


def drawn(sample):
    return {address for address, stratum in sample.items() if stratum == "random"}


def test_a_sample_is_the_same_for_the_same_date_and_rows_in_any_order():
    first = choose_sample("tempo", DAY, WALLETS, WALLETS[:2])
    again = choose_sample("tempo", DAY, list(reversed(WALLETS)), WALLETS[:2])

    assert first == again
    assert len(drawn(first)) == 30


def test_a_sample_changes_with_the_date_and_with_the_chain():
    first = drawn(choose_sample("tempo", DAY, WALLETS, []))

    assert drawn(choose_sample("tempo", "2026-11-05", WALLETS, [])) != first
    assert drawn(choose_sample("base", DAY, WALLETS, [])) != first


def test_a_new_candidate_changes_at_most_one_drawn_wallet():
    first = drawn(choose_sample("tempo", DAY, WALLETS, []))

    for number in range(101, 200):
        after = drawn(choose_sample("tempo", DAY, [*WALLETS, wallet(number)], []))
        assert len(after - first) <= 1
        assert len(first - after) <= 1


def test_a_sample_has_a_fixed_answer_so_a_new_algorithm_cannot_pass_unnoticed():
    # The ranks are sha256("v1|tempo|2026-11-04|<address>"), worked out outside this code.
    assert drawn(choose_sample("tempo", DAY, WALLETS[:32], [])) == set(WALLETS[:32]) - {
        wallet(9),
        wallet(13),
    }


@pytest.fixture
def tokyo_clock(monkeypatch):
    """A machine clock far from UTC, so a date taken in local time differs."""
    monkeypatch.setenv("TZ", "Asia/Tokyo")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


MIDNIGHT = datetime(2026, 11, 4, tzinfo=UTC).timestamp()


@pytest.mark.parametrize(
    ("now", "date"),
    [(MIDNIGHT - 1, "2026-11-03"), (MIDNIGHT, "2026-11-04")],
    ids=["last-second", "first-second"],
)
def test_the_seed_takes_its_date_from_utc_either_side_of_midnight(store, tokyo_clock, now, date):
    run_it(store, four_probes(store), None, clock=lambda: now)

    assert {row[3] for row in samples(store)} == {f"v1|tempo|{date}"}


def test_a_sample_counts_are_twenty_top_and_thirty_drawn():
    top = WALLETS[:20]

    sample = choose_sample("tempo", DAY, WALLETS, top)

    assert [address for address, stratum in sample.items() if stratum == "top"] == top
    assert len(drawn(sample)) == 30
    assert len(sample) == 50


def test_fewer_candidates_than_asked_gives_all_of_them():
    sample = choose_sample("tempo", DAY, WALLETS[:3], WALLETS[:1])

    assert sample.keys() == set(WALLETS[:3])
    assert sample[WALLETS[0]] == "top"


def test_a_wallet_in_two_strata_appears_once_in_the_first_listed():
    every = choose_sample("tempo", DAY, WALLETS[:5], [])
    assert set(drawn(every)) == set(WALLETS[:5])

    sample = choose_sample("tempo", DAY, WALLETS[:5], WALLETS[:5])

    assert set(sample.values()) == {"top"}
    assert len(sample) == 5


@pytest.mark.parametrize("census", [False, True], ids=["sample", "census"])
def test_the_zero_address_is_never_chosen(census):
    sample = choose_sample("tempo", DAY, [ZERO_ADDRESS, *WALLETS], [ZERO_ADDRESS], census)

    assert ZERO_ADDRESS not in sample


def test_a_census_gives_every_candidate_and_keeps_the_strata():
    sample = choose_sample("tempo", DAY, WALLETS, WALLETS[:20], census=True)

    assert sample.keys() == set(WALLETS)
    assert list(sample.values()).count("top") == 20
    assert list(sample.values()).count("random") == 30
    assert list(sample.values()).count("census") == 50


def samples(store, chain="tempo"):
    return store.db.execute(
        """
        SELECT attempt, address, stratum, seed, height, model_balance, observed_balance
        FROM balance_samples WHERE chain = ? ORDER BY attempt, address
        """,
        [chain],
    ).fetchall()


# Sampled balances, over the same fake chain as the supply checks.


def test_equal_balances_pass_and_each_wallet_is_recorded(store):
    probes, _ = tempo_probes(store)

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("pass", 0)
    assert checks(store, "sampled_balances", "tempo") == [(1, "pass", None)]
    seed = "v1|tempo|1970-01-01"
    assert samples(store) == [
        (1, ALICE, "top", seed, 120, LARGE - 7, LARGE - 7),
        (1, BOB, "top", seed, 120, 7, 7),
    ]
    assert check_detail(store, "sampled_balances", "tempo")["wallets"] == 2


def test_a_sampled_row_records_the_pin_like_the_gate(store):
    probes, tempo = tempo_probes(store)

    run_it(store, probes)

    row = store.db.execute(
        """
        SELECT pin_height, pin_hash, transfer_count FROM reconciliation_checks
        WHERE check_name = 'sampled_balances' AND subject = 'tempo'
        """
    ).fetchone()
    assert row == (120, tempo.rpc.hashes[120], 2)


def test_a_balance_one_base_unit_off_fails_above_two_to_the_sixty(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(ALICE, 1), off_by(ALICE, 1)]

    result, reported = run_it(store, probes)

    assert (result.chains["tempo"], result.status, result.exit_code) == ("fail", "fail", 1)
    assert result.chains["base"] == "pass"
    assert checks(store, "sampled_balances", "tempo") == [
        (1, "fail", "balance_mismatch"),
        (2, "fail", "balance_mismatch"),
    ]
    # Exact, so it can't be lost to a float on the way into the table.
    wrong = samples(store)[-1]
    assert wrong[1] == ALICE
    assert (wrong[5], wrong[6]) == (LARGE - 7, LARGE - 7 + 1)
    assert [item for item in reported if isinstance(item, BalanceFinding)] == [
        BalanceFinding("tempo", 1, ALICE, 120, LARGE - 7, LARGE - 7 + 1),
        BalanceFinding("tempo", 2, ALICE, 120, LARGE - 7, LARGE - 7 + 1),
    ]
    assert ALICE not in stored_check_text(store)
    assert not store.latest_reconciliation().usable


@pytest.mark.parametrize(
    "lie",
    [
        lambda reads: reads[:-1],
        lambda reads: [*reads, BalanceRead(CAROL, reads[0].height, 0)],
        lambda reads: [],
        lambda reads: [reads[0], reads[0]],
    ],
    ids=["missing", "extra", "empty", "repeated"],
)
def test_readings_that_are_not_exactly_the_wallets_asked_for_are_unchecked(store, lie):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [lie]

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "sampled_balances", "tempo") == [(1, "unchecked", "sample_incomplete")]
    assert not store.latest_reconciliation().usable


def test_a_chain_with_no_wallets_is_an_empty_sample_and_never_a_pass(store):
    probes, tempo = tempo_probes(store)
    tempo.rpc.logs.clear()

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "sampled_balances", "tempo") == [(1, "unchecked", "sample_incomplete")]


@pytest.mark.parametrize(
    ("step", "status", "reason"),
    [
        (ChainUnavailable("state_unavailable"), "unchecked", "state_unavailable"),
        (Unchecked("tempo", "not_synced"), "unchecked", "not_synced"),
        (StoreConflict("moved row"), "fail", "store_conflict"),
    ],
    ids=["refused", "unchecked-return", "conflict"],
)
def test_a_balance_read_that_cannot_be_made_is_recorded_with_its_code(store, step, status, reason):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [step]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == status
    assert checks(store, "sampled_balances", "tempo") == [(1, status, reason)]
    assert result.chains["base"] == "pass"


def test_a_read_above_the_cursor_is_unchecked_as_its_rows_are_not_stored(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [lambda reads: [read._replace(height=121) for read in reads]]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "unchecked"
    assert checks(store, "sampled_balances", "tempo") == [(1, "unchecked", "above_cursor")]


def test_an_error_a_probe_failed_to_map_in_a_balance_read_leaves_the_run_unfinished(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [KeyError("a bug")]

    with pytest.raises(KeyError):
        run_it(store, probes)

    assert runs(store) == [("full", None, None, True)]


def lose(probe, block):
    """The node stops returning this block's logs, which still move its balances and supply."""
    real = probe.rpc.transfers
    probe.rpc.transfers = lambda token, start, end: [
        transfer for transfer in real(token, start, end) if transfer.block_number != block
    ]


def test_a_lost_ordinary_transfer_passes_supply_and_fails_balances(store):
    probes, tempo = tempo_probes(store)
    tempo.rpc.add_transfer(110, 5, sender=ALICE, to=BOB)
    lose(tempo, 110)

    result, _ = run_it(store, probes)

    assert checks(store, "chain_supply", "tempo")[0] == (1, "pass", None)
    assert checks(store, "sampled_balances", "tempo")[-1] == (2, "fail", "balance_mismatch")
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)


def test_a_mismatch_that_heals_passes_reading_only_that_wallet_after_a_sync(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(BOB, 1)]

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("pass", 0)
    assert [wallets for wallets, _ in tempo.balance_reads] == [[ALICE, BOB], [BOB]]
    assert tempo.events == ["sync", "read", "balances", "sync", "read", "balances"]
    assert checks(store, "sampled_balances", "tempo") == [
        (1, "fail", "balance_mismatch"),
        (2, "pass", None),
    ]
    assert checks(store, "chain_supply", "tempo") == [(1, "pass", None), (2, "pass", None)]
    assert [(row[0], row[1], row[2]) for row in samples(store)] == [
        (1, ALICE, "top"),
        (1, BOB, "top"),
        (2, BOB, "top"),
    ]
    assert store.latest_reconciliation().usable


def test_a_mismatch_that_persists_takes_exactly_one_more_sync(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(BOB, 1), off_by(BOB, 1)]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert tempo.syncs() == 2
    assert len(tempo.balance_reads) == 2


def test_a_mismatch_whose_resync_cannot_be_read_is_unchecked(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(BOB, 1)]
    tempo.steps = [None, ChainUnavailable("sync_failed")]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "unchecked"
    assert result.exit_code == 3
    assert checks(store, "chain_supply", "tempo")[-1] == (2, "unchecked", "sync_failed")
    assert len(tempo.balance_reads) == 1
    assert not store.latest_reconciliation().usable


def test_a_mismatch_whose_recheck_cannot_be_read_is_unchecked(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(BOB, 1), ChainUnavailable("state_unavailable")]

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "sampled_balances", "tempo") == [
        (1, "fail", "balance_mismatch"),
        (2, "unchecked", "state_unavailable"),
    ]


def test_a_mismatch_whose_resync_finds_a_supply_mismatch_fails_through_its_own_retry(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(BOB, 1)]
    tempo.steps = [None, Drift(1), Drift(1)]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert checks(store, "chain_supply", "tempo") == [
        (1, "pass", None),
        (2, "fail", "supply_mismatch"),
        (3, "fail", "supply_mismatch"),
    ]


def test_a_failed_supply_reads_no_balances(store):
    probes, tempo = tempo_probes(store)
    tempo.steps = [Drift(1), Drift(1)]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert tempo.balance_reads == []
    assert checks(store, "sampled_balances", "tempo") == []


def test_a_chain_that_cannot_be_read_gets_no_balance_or_group_rows(store):
    probes, tempo = tempo_probes(store)
    tempo.steps = [ChainUnavailable("not_synced")]

    run_it(store, probes)

    assert checks(store, "sampled_balances", "tempo") == []
    assert checks(store, "same_looking", "tempo") == []


# Later pins: a Bridge retry, or a read that moved the cursor.


def test_a_later_pin_reads_each_wallet_touched_since_at_that_pin(store):
    probes, tempo = tempo_probes(store)

    def advance(seconds):
        tempo.rpc.extend(130)
        tempo.rpc.add_transfer(125, 2, sender=BOB, to=CAROL)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=advance)

    assert (result.exit_code, result.bridge) == (0, "pass")
    pin = tempo.balance_reads[-1]
    assert pin == ([BOB, CAROL], tempo.store.synced_through("tempo"))
    assert [(row[0], row[1], row[2], row[4]) for row in samples(store) if row[0] == 2] == [
        (2, BOB, "delta", 130),
        (2, CAROL, "delta", 130),
    ]
    assert checks(store, "sampled_balances", "tempo") == [(1, "pass", None), (2, "pass", None)]
    assert store.latest_reconciliation().usable


def test_a_later_pin_with_no_wallet_touched_reads_nothing_and_says_so(store):
    probes, tempo = tempo_probes(store)

    def advance(seconds):
        tempo.rpc.extend(130)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=advance)

    assert result.exit_code == 0
    assert len(tempo.balance_reads) == 1
    assert checks(store, "sampled_balances", "tempo") == [(1, "pass", None), (2, "pass", None)]
    assert check_detail(store, "sampled_balances", "tempo", 2)["wallets"] == 0


def test_a_retry_at_the_same_pin_reads_nothing_more(store):
    probes, tempo = tempo_probes(store)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)))

    assert result.exit_code == 0
    assert len(tempo.balance_reads) == 1
    assert checks(store, "sampled_balances", "tempo") == [(1, "pass", None)]
    # The audit still runs against every final pin.
    assert checks(store, "same_looking", "tempo") == [(1, "pass", None), (2, "pass", None)]


def test_a_transfer_lost_between_two_pins_fails_the_run_and_never_exits_zero(store):
    probes, tempo = tempo_probes(store)

    def lose_one(seconds):
        tempo.rpc.extend(130)
        # Bob sent Dan 5, and that row is never returned. Bob's later row is what brings him back.
        tempo.rpc.add_transfer(123, 5, sender=BOB, to=DAN)
        lose(tempo, 123)
        tempo.rpc.add_transfer(125, 1, sender=BOB, to=CAROL)

    # Supply can't see it, and the second snapshot would pass, were it not for the check on the
    # new pin.
    result, reported = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=lose_one)

    assert checks(store, "chain_supply", "tempo")[1] == (2, "pass", None)
    assert checks(store, "sampled_balances", "tempo") == [
        (1, "pass", None),
        (2, "fail", "balance_mismatch"),
        (3, "fail", "balance_mismatch"),
    ]
    assert result.chains["tempo"] == "fail"
    assert (result.status, result.exit_code) == ("fail", 1)
    assert checks(store, "bridge", "all") == [
        (1, "fail", "bridge_mismatch"),
        (2, "unchecked", "chains_not_passed"),
    ]
    assert not store.latest_reconciliation().usable
    finding = next(item for item in reported if isinstance(item, BalanceFinding))
    assert (finding.address, finding.height) == (BOB, 130)
    assert (finding.model_balance, finding.observed_balance) == (6, 1)


def test_a_transfer_lost_between_wallets_with_no_later_row_exits_zero(store):
    # The limit the plan accepts, pinned so it can't change unnoticed in either direction. Bob's
    # reading stands from before the loss, and no later row brings him back.
    probes, tempo = tempo_probes(store)

    def lose_one(seconds):
        tempo.rpc.extend(130)
        tempo.rpc.add_transfer(123, 5, sender=BOB, to=DAN)
        lose(tempo, 123)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=lose_one)

    assert (result.chains["tempo"], result.exit_code) == ("pass", 0)
    assert store.latest_reconciliation().usable
    assert len(tempo.balance_reads) == 1
    assert store.balances_at("tempo", [BOB], 130)[BOB] == 7
    assert tempo.rpc.balance_of(tempo.chain.token, BOB, 130) == 2


def test_a_group_that_appears_between_two_pins_is_audited_at_the_new_pin(store):
    probes, tempo = tempo_probes(store)

    def add_group(seconds):
        tempo.rpc.extend(130)
        same_transaction(tempo, 125, TX, (BOB, CAROL, 1), (BOB, CAROL, 1))
        tempo.proofs[TX] = proof_of(tempo, TX, positions=[0])

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=add_group)

    assert result.chains["tempo"] == "fail"
    assert (result.status, result.exit_code) == ("fail", 1)
    assert checks(store, "same_looking", "tempo") == [
        (1, "pass", None),
        (2, "fail", "group_not_real"),
    ]
    assert audit(store, TX)[:2] == ("not_real", "receipt")


# A fork that replaces rows already compared. A delta only reads above what it has covered.


def fork_losing_a_transfer(probe, new_tip=None):
    """Replace the last blocks with a fork holding a Bob to Dan transfer sync never gets."""
    probe.rpc.reorg(from_block=118, new_tip=new_tip)
    probe.rpc.add_transfer(118, 5, sender=BOB, to=DAN)
    lose(probe, 118)


def test_a_fork_at_the_covered_height_between_attempts_reads_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def fork(seconds):
        fork_losing_a_transfer(tempo)

    # The second snapshot would pass, and the pin is the same height with a new hash.
    result, reported = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=fork)

    assert checks(store, "chain_supply", "tempo")[1] == (2, "pass", None)
    assert [wallets for wallets, _ in tempo.balance_reads[:2]] == [[ALICE, BOB], [ALICE, BOB]]
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    finding = next(item for item in reported if isinstance(item, BalanceFinding))
    assert (finding.address, finding.model_balance, finding.observed_balance) == (BOB, 7, 2)
    assert not store.latest_reconciliation().usable


def test_a_fork_to_a_shorter_chain_between_attempts_reads_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def fork(seconds):
        fork_losing_a_transfer(tempo, new_tip=119)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=fork)

    assert [height for _, height in tempo.balance_reads[:2]] == [120, 119]
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert not store.latest_reconciliation().usable


def test_a_fork_in_the_resync_a_mismatch_sets_off_reads_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def mismatch_then_fork(reads):
        fork_losing_a_transfer(tempo)
        return off_by(ALICE, 1)(reads)

    tempo.balance_steps = [mismatch_then_fork]

    result, _ = run_it(store, probes)

    # Alice heals on her recheck, and Bob's first reading was on the old fork.
    assert [wallets for wallets, _ in tempo.balance_reads[:3]] == [
        [ALICE, BOB],
        [ALICE],
        [ALICE, BOB],
    ]
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert not store.latest_reconciliation().usable


def test_a_fork_to_a_shorter_chain_in_a_mismatch_resync_reads_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def mismatch_then_fork(reads):
        fork_losing_a_transfer(tempo, new_tip=119)
        return off_by(ALICE, 1)(reads)

    tempo.balance_steps = [mismatch_then_fork]

    result, _ = run_it(store, probes)

    assert tempo.balance_reads[:3] == [([ALICE, BOB], 120), ([ALICE], 119), ([ALICE, BOB], 119)]
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert not store.latest_reconciliation().usable


def test_a_fork_in_the_resync_of_a_later_pin_reads_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def advance(seconds):
        tempo.rpc.extend(130)
        tempo.rpc.add_transfer(125, 6, sender=BOB, to=CAROL)

    def mismatch_then_fork(reads):
        # Carol's reading is on the old fork, and only Bob is read again.
        tempo.rpc.reorg(from_block=128)
        tempo.rpc.add_transfer(128, 5, sender=CAROL, to=DAN)
        lose(tempo, 128)
        return off_by(BOB, 1)(reads)

    tempo.balance_steps = [None, mismatch_then_fork]

    result, reported = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=advance)

    assert [wallets for wallets, _ in tempo.balance_reads[1:3]] == [[BOB, CAROL], [BOB]]
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert CAROL in [item.address for item in reported if isinstance(item, BalanceFinding)]
    assert not store.latest_reconciliation().usable


def test_a_census_is_read_again_after_a_fork_and_only_then(store):
    probes = census_probes(store)
    ethereum = probes[1]

    def fork(seconds):
        ethereum.rpc.reorg(from_block=118)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=fork, census=["ethereum"])

    assert result.exit_code == 0
    assert len(ethereum.balance_reads) == 2
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None), (2, "pass", None)]
    assert store.census_complete("ethereum")
    assert store.latest_reconciliation().usable


def test_a_clean_fork_passes_after_reading_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def fork(seconds):
        tempo.rpc.reorg(from_block=118)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=fork)

    assert result.exit_code == 0
    assert len(tempo.balance_reads) == 2
    assert store.latest_reconciliation().usable


def test_a_fork_above_the_covered_height_is_left_to_the_delta(store):
    probes, tempo = tempo_probes(store)

    def fork(seconds):
        tempo.rpc.extend(125)
        tempo.rpc.add_transfer(123, 1, sender=BOB, to=CAROL)
        tempo._sync()
        tempo.rpc.reorg(from_block=122)
        tempo.rpc.add_transfer(122, 1, sender=BOB, to=CAROL)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=fork)

    assert result.exit_code == 0
    assert tempo.balance_reads[-1] == ([BOB, CAROL], 125)
    assert len(tempo.balance_reads) == 2


def test_a_hash_pruned_as_final_is_not_taken_for_a_fork(store):
    probes, tempo = tempo_probes(store)

    def advance(seconds):
        tempo.rpc.extend(200)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=advance)

    assert 120 not in store.block_hashes("tempo")
    assert result.exit_code == 0
    assert len(tempo.balance_reads) == 1


# A chain like Solana: no past-state read, and a read that syncs through the slot it reports.


def test_a_read_that_moves_the_cursor_gets_another_supply_check(store):
    probes, solana = slot_probes(store, ahead=1)
    only_the_first_read_moves_the_cursor(solana)

    result, _ = run_it(store, probes)

    assert solana.events == ["sync", "read", "balances", "sync", "read"]
    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    assert checks(store, "chain_supply", "solana") == [(1, "pass", None), (2, "pass", None)]
    final = store.latest_reconciliation().chains["solana"]
    assert final.pin_height == store.synced_through("solana") == 121
    assert store.latest_reconciliation().usable


def test_a_read_that_does_not_move_the_cursor_gets_no_second_supply_check(store):
    probes, solana = slot_probes(store)

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert solana.events == ["sync", "read", "balances"]
    assert checks(store, "chain_supply", "solana") == [(1, "pass", None)]


def test_a_mismatch_on_the_second_supply_check_goes_through_the_normal_retry(store):
    probes, solana = slot_probes(store, ahead=1)
    solana.steps = [None, Drift(1)]
    only_the_first_read_moves_the_cursor(solana)

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    assert checks(store, "chain_supply", "solana") == [
        (1, "pass", None),
        (2, "fail", "supply_mismatch"),
        (3, "pass", None),
    ]
    assert store.latest_reconciliation().usable


def test_a_wallet_first_seen_between_the_pin_and_the_read_is_still_read(store):
    probes, solana = slot_probes(store, ahead=1)
    only_the_first_read_moves_the_cursor(solana)
    real = solana._true_balances

    def carol_arrives(addresses, height):
        solana.rpc.extend(121)
        solana.rpc.add_transfer(121, 1, sender=ALICE, to=CAROL)
        solana._true_balances = real
        solana.ahead = 0
        return real(addresses, height)

    solana._true_balances = carol_arrives

    result, _ = run_it(store, probes)

    assert solana.balance_reads[0][0] == [ALICE, BOB]
    assert solana.balance_reads[1] == ([ALICE, CAROL], 121)
    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    assert store.latest_reconciliation().usable


def busy_for(probe, windows):
    """After the first supply check, this many more each find a new row, and the rest find none."""
    checks_seen = [0]

    def touch():
        checks_seen[0] += 1
        if 1 < checks_seen[0] <= windows + 1:
            tip = probe.rpc.tip() + 1
            probe.rpc.extend(tip)
            probe.rpc.add_transfer(tip, 1, sender=ALICE, to=BOB)

    probe.before_supply = touch


def test_three_busy_windows_use_every_round_and_a_fourth_is_never_tried(store):
    probes, solana = slot_probes(store, ahead=1)
    busy_for(solana, 3)

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.exit_code) == ("unchecked", 3)
    # The sample and three rounds. The fourth window would be quiet, and isn't looked at.
    assert len(solana.balance_reads) == 4
    assert solana.events.count("read") == 4
    assert checks(store, "sampled_balances", "solana") == [
        (1, "pass", None),
        (2, "pass", None),
        (3, "pass", None),
        (4, "pass", None),
        (5, "unchecked", "pin_behind_cursor"),
    ]
    assert not store.latest_reconciliation().usable


def test_two_busy_windows_then_a_quiet_one_pass_on_the_last_round(store):
    probes, solana = slot_probes(store, ahead=1)
    busy_for(solana, 2)

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    assert solana.events.count("read") == 4
    assert len(solana.balance_reads) == 3
    assert check_detail(store, "sampled_balances", "solana", 4)["wallets"] == 0
    assert store.latest_reconciliation().usable


def test_a_lagging_recheck_on_solana_lowers_what_the_read_covers(store):
    probes, solana = slot_probes(store)
    solana.rpc.add_transfer(120, 3, sender=ALICE, to=BOB)

    def mismatch_then_lag(reads):
        solana.behind = 1
        return off_by(BOB, 1)(reads)

    def catch_up(reads):
        solana.behind = 0
        return reads

    solana.balance_steps = [mismatch_then_lag, catch_up]

    result, _ = run_it(store, probes)

    # Bob's recheck stops at 119, so the row at 120 is still to be covered, at the pin.
    assert solana.balance_reads == [
        ([ALICE, BOB], 120),
        ([BOB], 120),
        ([ALICE, BOB], 120),
    ]
    assert [(row[0], row[1], row[2], row[4]) for row in samples(store, "solana")][2:] == [
        (2, BOB, "top", 119),
        (3, ALICE, "delta", 120),
        (3, BOB, "delta", 120),
    ]
    assert (result.chains["solana"], result.exit_code) == ("pass", 0)


def test_a_cursor_that_keeps_moving_is_never_a_pass(store):
    probes, solana = slot_probes(store, ahead=1)

    def touch():
        tip = solana.rpc.tip()
        solana.rpc.extend(tip + 1)
        solana.rpc.add_transfer(tip + 1, 1, sender=ALICE, to=BOB)

    solana.before_supply = touch

    result, _ = run_it(store, probes)

    assert result.chains["solana"] == "unchecked"
    assert result.exit_code == 3
    assert checks(store, "sampled_balances", "solana")[-1][1:] == (
        "unchecked",
        "pin_behind_cursor",
    )
    assert not store.latest_reconciliation().usable


def test_readings_at_their_own_slots_are_each_compared_at_that_slot(store):
    probes, solana = slot_probes(store, spread=True)
    # Bob's reading lands one slot below the tip, and a transfer lands on the tip.
    solana.rpc.add_transfer(120, 3, sender=ALICE, to=BOB)

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    heights = {row[1]: row[4] for row in samples(store, "solana") if row[0] == 1}
    assert heights == {ALICE: 120, BOB: 119}
    bob = next(row for row in samples(store, "solana") if row[0] == 1 and row[1] == BOB)
    assert (bob[5], bob[6]) == (7, 7)


def test_a_read_below_the_cursor_is_compared_at_its_slot_then_covered_at_the_pin(store):
    probes, solana = slot_probes(store, behind=1)
    solana.rpc.add_transfer(120, 3, sender=ALICE, to=BOB)
    real = solana._true_balances

    def catch_up(addresses, height):
        reads = real(addresses, height)
        solana.behind = 0
        return reads

    solana._true_balances = catch_up

    result, _ = run_it(store, probes)

    # At the cursor this would differ by 3. At the read's slot, it matches.
    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    first = [row for row in samples(store, "solana") if row[0] == 1]
    assert {(row[1], row[4]) for row in first} == {(ALICE, 119), (BOB, 119)}
    assert solana.balance_reads[1][0] == [ALICE, BOB]
    delta = [row for row in samples(store, "solana") if row[0] == 2]
    assert {(row[1], row[2], row[4]) for row in delta} == {
        (ALICE, "delta", 120),
        (BOB, "delta", 120),
    }


def test_a_read_that_stays_below_the_pin_is_never_a_pass(store):
    probes, solana = slot_probes(store, behind=1)
    solana.rpc.add_transfer(120, 3, sender=ALICE, to=BOB)

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "sampled_balances", "solana")[-1][1:] == (
        "unchecked",
        "pin_behind_cursor",
    )


def test_every_wallet_is_read_on_solana_with_no_census_asked_for(store):
    probes, solana = slot_probes(store)
    for number in range(1, 80):
        solana.rpc.add_transfer(103, 1, sender=ALICE, to=wallet(number))

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    read, _ = solana.balance_reads[0]
    assert set(read) == {ALICE, BOB, *(wallet(number) for number in range(1, 80))}
    strata = {row[2] for row in samples(store, "solana")}
    assert strata == {"top", "random", "census"}
    assert checks(store, "balance_census", "solana") == [(1, "pass", None)]


def test_an_evm_chain_reads_only_its_sample_with_no_census_asked_for(store):
    probes, tempo = tempo_probes(store)
    for number in range(1, 80):
        tempo.rpc.add_transfer(103, 1, sender=ALICE, to=wallet(number))

    run_it(store, probes)

    assert len(tempo.balance_reads[0][0]) == 50
    assert checks(store, "balance_census", "tempo") == []


# The census


def test_a_census_reads_every_wallet_and_lets_the_chain_pass(store):
    probes = census_probes(store)
    ethereum = probes[1]
    for number in range(1, 80):
        ethereum.rpc.add_transfer(103, 1, sender=ALICE, to=wallet(number))

    result, _ = run_it(store, probes, census=["ethereum"])

    assert (result.chains["ethereum"], result.exit_code) == ("pass", 0)
    read, _ = ethereum.balance_reads[0]
    assert set(read) == {ALICE, BOB, *(wallet(number) for number in range(1, 80))}
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None)]
    strata = [row[2] for row in samples(store, "ethereum")]
    assert (strata.count("top"), strata.count("random"), strata.count("census")) == (20, 30, 31)
    assert store.census_complete("ethereum")
    assert store.latest_reconciliation().usable


def test_a_later_run_needs_no_second_census_and_reads_only_its_sample(store):
    probes = census_probes(store)
    ethereum = probes[1]
    for number in range(1, 80):
        ethereum.rpc.add_transfer(103, 1, sender=ALICE, to=wallet(number))
    run_it(store, probes, census=["ethereum"])
    ethereum.balance_reads.clear()

    result, _ = run_it(store, probes)

    assert (result.chains["ethereum"], result.exit_code) == ("pass", 0)
    assert len(ethereum.balance_reads[0][0]) == 50
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None)]


def test_a_census_that_cannot_finish_does_not_count_and_leaves_the_chain_unchecked(store):
    probes = census_probes(store)
    probes[1].balance_steps = [ChainUnavailable("state_unavailable")]

    result, _ = run_it(store, probes, census=["ethereum"])

    assert (result.chains["ethereum"], result.exit_code) == ("unchecked", 3)
    assert not store.census_complete("ethereum")
    assert checks(store, "balance_census", "ethereum") == [
        (1, "unchecked", "state_unavailable"),
        (2, "unchecked", "census_missing"),
    ]


def test_a_census_that_finds_a_difference_fails_and_does_not_count(store):
    probes = census_probes(store)
    probes[1].balance_steps = [off_by(BOB, 1), off_by(BOB, 1)]

    result, _ = run_it(store, probes, census=["ethereum"])

    assert (result.chains["ethereum"], result.exit_code) == ("fail", 1)
    assert not store.census_complete("ethereum")
    assert checks(store, "balance_census", "ethereum")[0] == (1, "fail", "balance_mismatch")


def test_a_census_that_heals_on_its_retry_counts_once(store):
    probes = census_probes(store)
    probes[1].balance_steps = [off_by(BOB, 1)]

    result, _ = run_it(store, probes, census=["ethereum"])

    assert (result.chains["ethereum"], result.exit_code) == ("pass", 0)
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None)]


def test_the_newest_census_is_the_one_that_counts(store):
    probes = census_probes(store)
    run_it(store, probes, census=["ethereum"])
    assert store.census_complete("ethereum")

    # A later census of every wallet finds a difference, so the old pass no longer stands.
    probes[1].balance_steps = [off_by(BOB, 1), off_by(BOB, 1)]
    run_it(store, probes, census=["ethereum"])
    assert not store.census_complete("ethereum")

    result, _ = run_it(store, probes)

    assert (result.chains["ethereum"], result.exit_code) == ("unchecked", 3)
    assert newest_run_checks(store, "balance_census", "ethereum") == [
        (1, "unchecked", "census_missing")
    ]


def test_a_census_is_read_once_across_bridge_retries(store):
    probes = census_probes(store)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), census=["ethereum"])

    assert result.exit_code == 0
    assert len(probes[1].balance_reads) == 1
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None)]


def test_a_census_of_a_chain_with_no_probe_is_refused_before_a_run_starts(store):
    with pytest.raises(ValueError, match="census of a chain with no probe"):
        run_it(store, [FakeProbe(store, "tempo")], census=["ethereum"])

    assert runs(store) == []
