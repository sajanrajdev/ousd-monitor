import httpx
import pytest
from conftest import ALICE, BOB
from ousd.decode import ZERO_ADDRESS
from ousd.http import HttpError, PoliteClient
from ousd.reconcile import ChainUnavailable, GroupFinding
from ousd.sources import ProofTransfer, RpcClient, TransactionProof
from reconcile_fakes import (
    CAROL,
    KEY,
    TX,
    Drift,
    audit,
    caused_by,
    check_detail,
    checks,
    newest_run_checks,
    off_by,
    proof_of,
    run_it,
    same_transaction,
    slot_probes,
    stored_check_text,
    tempo_probes,
)

# Same-looking transfers. See "Whether same-looking transfers are real" in the reconciliation plan.

TX_2 = "0x" + "2" * 64


def transfer_rows(store, chain="tempo"):
    return store.db.execute(
        """
        SELECT block_number, log_index, tx_hash, from_address, to_address, value
        FROM transfers WHERE chain = ? ORDER BY block_number, log_index
        """,
        [chain],
    ).fetchall()


def test_a_real_group_is_recorded_with_its_source_and_never_read_again(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("pass", 0)
    assert checks(store, "same_looking", "tempo") == [(1, "pass", None)]
    assert audit(store, TX) == ("real", "receipt", [0, 1], [0, 1], 110)
    assert tempo.proof_reads == [TX]
    assert check_detail(store, "same_looking", "tempo")["proof_sources"] == {"receipt": 1}

    tempo.proof_reads.clear()
    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert tempo.proof_reads == []
    assert check_detail(store, "same_looking", "tempo")["transactions"] == 0


def test_a_mixed_transaction_is_proven_once_and_does_not_come_back(store):
    probes, tempo = tempo_probes(store)
    # A group at 0 and 2, and a row of the same transaction at 1 that isn't in it.
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, CAROL, 9), (ALICE, BOB, 2))

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert audit(store, TX) == ("real", "receipt", [0, 1, 2], [0, 1, 2], 110)
    assert tempo.proof_reads == [TX]

    run_it(store, probes)

    assert tempo.proof_reads == [TX]


def test_a_mixed_transaction_missing_the_row_outside_the_group_is_not_real(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, CAROL, 9), (ALICE, BOB, 2))
    # The node returns the group's rows, and loses their sibling.
    real = tempo.rpc.transfers
    tempo.rpc.transfers = lambda token, start, end: [
        row for row in real(token, start, end) if (row.block_number, row.log_index) != (110, 1)
    ]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert audit(store, TX)[:4] == ("not_real", "receipt", [0, 2], [0, 1, 2])


def test_a_transaction_with_two_groups_is_read_once(store):
    probes, tempo = tempo_probes(store)
    same_transaction(
        tempo, 110, TX, (ALICE, BOB, 2), (BOB, ALICE, 2), (ALICE, BOB, 2), (BOB, ALICE, 2)
    )

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert tempo.proof_reads == [TX]
    assert check_detail(store, "same_looking", "tempo")["transactions"] == 1


def test_a_loop_that_nets_to_zero_is_decided_by_the_receipt_not_by_balances(store):
    probes, tempo = tempo_probes(store)
    moves = [(ALICE, BOB, 2)] * 4 + [(BOB, ALICE, 2)] * 4
    same_transaction(tempo, 110, TX, *moves)
    # Only one each way really happened: three rows each way are extra, and they cancel.
    tempo.proofs[TX] = proof_of(tempo, TX, positions=[0, 4])

    result, reported = run_it(store, probes)

    assert checks(store, "sampled_balances", "tempo") == [(1, "pass", None)]
    assert checks(store, "chain_supply", "tempo") == [(1, "pass", None)]
    assert checks(store, "same_looking", "tempo") == [(1, "fail", "group_not_real")]
    assert (result.chains["tempo"], result.status, result.exit_code) == ("fail", "fail", 1)
    assert audit(store, TX)[:4] == ("not_real", "receipt", list(range(8)), [0, 4])
    # The eight rows of the loop, and the two every fake chain starts with.
    assert len(transfer_rows(store)) == 10
    assert [item for item in reported if isinstance(item, GroupFinding)] == [
        GroupFinding("tempo", TX, "not_real", tuple(range(8)), (0, 4), False)
    ]
    assert not store.latest_reconciliation().usable


@pytest.mark.parametrize(
    ("change", "proven"),
    [
        ({"positions": [0]}, [0]),
        (
            {
                "transfers": [
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(5, ALICE, BOB, 2),
                ]
            },
            [0, 5],
        ),
        ({"success": False}, [0, 1]),
        (
            {
                "transfers": [
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(1, ALICE, BOB, 2),
                ]
            },
            [0, 0, 1],
        ),
        (
            {
                "transfers": [
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(1, ALICE, BOB, 2),
                    ProofTransfer(2, ALICE, CAROL, 4),
                ]
            },
            [0, 1, 2],
        ),
        (
            {
                "transfers": [
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(1, ALICE, CAROL, 2),
                ]
            },
            [0, 1],
        ),
        (
            {
                "transfers": [
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(1, ALICE, BOB, 3),
                ]
            },
            [0, 1],
        ),
    ],
    ids=[
        "fewer",
        "other-positions",
        "failed",
        "duplicate-entry",
        "lost-sibling",
        "other-receiver",
        "other-value",
    ],
)
def test_a_group_that_is_not_real_fails_and_every_row_stays(store, change, proven):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, **change)

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.status, result.exit_code) == ("fail", "fail", 1)
    assert checks(store, "same_looking", "tempo") == [(1, "fail", "group_not_real")]
    # Nothing is deleted or repaired, and both lists are there for the maintainer.
    kept = transfer_rows(store)
    assert [row[1] for row in kept if row[2] == TX] == [0, 1]
    assert audit(store, TX)[:4] == ("not_real", "receipt", [0, 1], proven)
    assert not store.latest_reconciliation().usable

    # It's read again on every run, so it clears only once it is fixed.
    tempo.proof_reads.clear()
    result, _ = run_it(store, probes)

    assert tempo.proof_reads == [TX]
    assert result.exit_code == 1
    assert transfer_rows(store) == kept


def test_a_group_that_is_not_real_clears_once_the_proof_agrees(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, positions=[0])
    run_it(store, probes)

    del tempo.proofs[TX]
    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert audit(store, TX)[0] == "real"


@pytest.mark.parametrize(
    "change",
    [{"tx_hash": TX_2}, {"block_number": 111}],
    ids=["another-transaction", "another-block"],
)
def test_a_proof_of_something_else_is_unavailable(store, change):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, **change)

    result, reported = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "same_looking", "tempo") == [(1, "unchecked", "group_proof_unavailable")]
    assert audit(store, TX) is None
    assert [item for item in reported if isinstance(item, GroupFinding)] == [
        GroupFinding("tempo", TX, "unavailable", (0, 1), (), False)
    ]


def test_a_proven_transaction_that_gains_a_row_is_proven_again_and_fails(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    run_it(store, probes)
    assert audit(store, TX)[0] == "real"
    tempo.proof_reads.clear()

    # A duplicate that got past the write guard, at a position the chain never had.
    store.db.execute(
        """
        INSERT INTO transfers
        SELECT chain, block_number, 9, block_hash, block_timestamp, tx_hash, from_address,
               to_address, value
        FROM transfers WHERE chain = 'tempo' AND tx_hash = ? AND log_index = 0
        """,
        [TX],
    )

    result, _ = run_it(store, probes)

    assert tempo.proof_reads == [TX]
    assert result.chains["tempo"] == "fail"
    assert newest_run_checks(store, "same_looking", "tempo") == [(1, "fail", "group_not_real")]
    assert audit(store, TX)[:4] == ("not_real", "receipt", [0, 1, 9], [0, 1])


def test_a_source_with_no_status_is_judged_on_its_rows_and_recorded_as_blockscout(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, success=None)

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert audit(store, TX)[:2] == ("real", "blockscout")


def test_a_source_with_no_status_still_fails_on_different_rows(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, positions=[0], success=None)

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert audit(store, TX)[:2] == ("not_real", "blockscout")


def test_a_failed_proof_is_not_real_and_is_read_once(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, success=False)

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert tempo.proof_reads == [TX]


def test_no_proof_from_any_source_is_unavailable(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = None

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "same_looking", "tempo") == [(1, "unchecked", "group_proof_unavailable")]
    assert not store.latest_reconciliation().usable


def test_a_solana_proof_is_recorded_as_a_transaction(store):
    probes, solana = slot_probes(store)
    same_transaction(solana, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert audit(store, TX, "solana")[:2] == ("real", "transaction")


def test_a_same_shaped_log_from_another_contract_is_not_counted(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    proof = proof_of(tempo, TX)
    transfer_topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
    origin_dollar = "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86"

    def log(address, index):
        return {
            "address": address,
            "topics": [
                transfer_topic,
                "0x" + ALICE[2:].rjust(64, "0"),
                "0x" + BOB[2:].rjust(64, "0"),
            ],
            "data": hex(2),
            "logIndex": hex(index),
        }

    # The real parser over a receipt holding the same transfer from Origin Dollar, the other OUSD.
    logs = [log(tempo.chain.token, 0), log(origin_dollar, 5), log(tempo.chain.token, 1)]
    receipt = {"transactionHash": TX, "blockNumber": hex(110), "status": "0x1", "logs": logs}
    http = PoliteClient(
        min_interval=0,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"id": 1, "result": receipt})
        ),
        sleep=lambda _: None,
    )

    tempo.proofs[TX] = RpcClient(http, "http://rpc.invalid").transaction_receipt(
        TX, tempo.chain.token
    )
    assert tempo.proofs[TX].transfers == proof.transfers

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert audit(store, TX)[0] == "real"


def test_a_group_mixing_hashed_and_unhashed_rows_is_flagged_and_its_proof_still_decides(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))

    # What sync sees a row from Blockscout as: no hash. Hide it from the next sync's re-read too.
    def mark_mixed(store):
        store.db.execute(
            "UPDATE transfers SET block_hash = NULL WHERE chain = 'tempo' AND log_index = 1"
            " AND tx_hash = ?",
            [TX],
        )

    tempo._sync()
    mark_mixed(store)
    real_sync = tempo._sync

    def sync_and_mark():
        real_sync()
        mark_mixed(store)

    tempo._sync = sync_and_mark

    result, reported = run_it(store, probes)

    assert result.exit_code == 0
    assert check_detail(store, "same_looking", "tempo")["mixed_hash_groups"] == 1
    assert [item for item in reported if isinstance(item, GroupFinding)] == [
        GroupFinding("tempo", TX, "real", (0, 1), (0, 1), True)
    ]


def test_a_group_with_all_its_hashes_is_not_flagged(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))

    _, reported = run_it(store, probes)

    assert check_detail(store, "same_looking", "tempo")["mixed_hash_groups"] == 0
    assert not [item for item in reported if isinstance(item, GroupFinding)]


def test_rolling_back_past_an_audited_transaction_audits_it_again(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 118, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    run_it(store, probes)
    assert audit(store, TX)[0] == "real"
    tempo.proof_reads.clear()

    tempo.rpc.reorg(from_block=118)
    same_transaction(tempo, 118, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert tempo.proof_reads == [TX]
    assert audit(store, TX)[0] == "real"


def test_each_verdict_is_committed_so_a_stopped_run_resumes(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    same_transaction(tempo, 111, TX_2, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX_2] = KeyError("a bug")

    with pytest.raises(KeyError):
        run_it(store, probes)

    assert audit(store, TX)[0] == "real"
    assert audit(store, TX_2) is None
    del tempo.proofs[TX_2]
    tempo.proof_reads.clear()

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert tempo.proof_reads == [TX_2]


def test_a_source_that_is_down_stops_the_audit_and_keeps_what_it_proved(store):
    probes, tempo = tempo_probes(store)
    third = "0x" + "3" * 64
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    same_transaction(tempo, 111, TX_2, (ALICE, BOB, 2), (ALICE, BOB, 2))
    same_transaction(tempo, 112, third, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX_2] = caused_by(ChainUnavailable("state_unavailable"), HttpError(KEY))

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "same_looking", "tempo") == [(1, "unchecked", "group_proof_unavailable")]
    assert tempo.proof_reads == [TX, TX_2]
    assert audit(store, TX)[0] == "real"
    detail = check_detail(store, "same_looking", "tempo")
    assert detail["error"] == "HttpError"
    assert (detail["transactions"], detail["real"], detail["unavailable"]) == (3, 1, 1)
    assert detail["not_attempted"] == 1
    assert KEY not in stored_check_text(store)

    del tempo.proofs[TX_2]
    tempo.proof_reads.clear()
    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert tempo.proof_reads == [TX_2, third]


def test_a_transaction_with_no_proof_does_not_stop_the_next(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    same_transaction(tempo, 111, TX_2, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = None

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert tempo.proof_reads == [TX, TX_2]
    assert audit(store, TX) is None
    assert audit(store, TX_2)[0] == "real"
    detail = check_detail(store, "same_looking", "tempo")
    assert (detail["real"], detail["unavailable"], detail["not_attempted"]) == (1, 1, 0)


@pytest.mark.parametrize("proven_in", [110, 111], ids=["lower-block", "higher-block"])
def test_rows_of_one_transaction_in_two_blocks_are_not_real_in_either_order(store, proven_in):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    same_transaction(tempo, 111, TX, (BOB, CAROL, 1), (BOB, CAROL, 1))
    tempo.proofs[TX] = TransactionProof(
        TX,
        proven_in,
        True,
        [
            ProofTransfer(0, ALICE, BOB, 2),
            ProofTransfer(1, ALICE, BOB, 2),
            ProofTransfer(0, BOB, CAROL, 1),
            ProofTransfer(1, BOB, CAROL, 1),
        ],
    )

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert checks(store, "same_looking", "tempo") == [(1, "fail", "group_not_real")]
    assert audit(store, TX)[0] == "not_real"


def test_a_failed_supply_still_audits_its_groups_as_a_duplicate_mint_shows_in_both(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ZERO_ADDRESS, ALICE, 2), (ZERO_ADDRESS, ALICE, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, positions=[0])
    tempo.steps = [Drift(-2), Drift(-2)]

    result, reported = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert checks(store, "same_looking", "tempo") == [(1, "fail", "group_not_real")]
    assert [item.verdict for item in reported if isinstance(item, GroupFinding)] == ["not_real"]


def test_a_group_found_real_never_gets_past_a_chain_that_failed(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.balance_steps = [off_by(ALICE, 1), off_by(ALICE, 1)]

    result, _ = run_it(store, probes)

    assert checks(store, "same_looking", "tempo") == [(1, "pass", None)]
    assert result.chains["tempo"] == "fail"
