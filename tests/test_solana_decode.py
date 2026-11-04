"""Decoding real captured Solana transactions. Negative cases mutate a fixture in memory."""

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from ousd.decode import ZERO_ADDRESS
from ousd.solana import TOKEN_2022, SolanaDataError, decode_transaction

FIXTURES = Path(__file__).parent / "fixtures" / "solana"
MINT = "ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB"
CONFIDENTIAL_MINT = "C76grNg6a957CNBzFnBPjSTBxx1Dx2t1kwUokqBrnwDM"
WITHDRAW_MINT = "4XiALZXT8jG9zH8JCJXkc8iRQshR7U3X1rtadEmd6q6d"


def load(name: str) -> dict[str, Any]:
    result: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    return result


def signature(tx: dict[str, Any]) -> str:
    return str(tx["transaction"]["signatures"][0])


def positions(rows) -> list[int]:
    return [row.log_index & 0xFFF for row in rows]


def test_inner_mint_ignores_the_second_mint():
    rows = decode_transaction(load("mint_inner_second_mint"), MINT)

    assert len(rows) == 1
    row = rows[0]
    assert row.block_number == 459708395
    assert row.log_index == (116 << 12) | 4 == 475140
    assert row.from_address == ZERO_ADDRESS
    assert row.to_address.startswith("Hmc2dLxZ")
    assert row.value == 30315020000
    assert row.block_hash is None


def test_inner_burn_ignores_the_second_mint():
    rows = decode_transaction(load("burn_inner_second_mint"), MINT)

    assert len(rows) == 1
    row = rows[0]
    assert row.block_number == 456218249
    assert row.log_index == (815 << 12) | 2 == 3338242
    assert row.from_address.startswith("3ZGf3ERi")
    assert row.to_address == ZERO_ADDRESS
    assert row.value == 4917380000


def test_failed_transaction_has_no_rows_though_it_records_an_ousd_instruction():
    assert decode_transaction(load("failed_inner_move"), MINT) == []


def test_version_1_gives_three_rows_in_execution_order():
    rows = decode_transaction(load("version_1"), MINT)

    assert [row.block_number for row in rows] == [465124245] * 3
    assert [row.value for row in rows] == [66383778] * 3
    assert positions(rows) == [19, 21, 24]
    assert [row.log_index for row in rows] == sorted(row.log_index for row in rows)


def test_version_0_inner_transfer():
    rows = decode_transaction(load("version_0_inner"), MINT)

    assert len(rows) == 1
    assert positions(rows) == [6]
    assert rows[0].value == 1051836175


def test_shared_position_gives_different_keys():
    a = decode_transaction(load("shared_position_a"), MINT)
    b = decode_transaction(load("shared_position_b"), MINT)

    assert [(r.block_number, r.value, r.log_index) for r in a + b] == [
        (463296214, 800000000, 1085441),
        (463296214, 10000000, 1093633),
    ]
    assert positions(a) == positions(b)


def test_transient_account_owner_comes_from_its_initializer():
    tx = load("transient_account")
    rows = decode_transaction(tx, MINT)

    assert len(rows) == 3
    assert {row.block_number for row in rows} == {463964747}
    assert {row.value for row in rows} == {490832379}
    # The transient account has no balance entry, so its owner (6GpvpHXB) comes from the
    # initializeAccount3. The plan names BQ72nSv9 as the middle owner, but that owner has a balance
    # entry, and is the receiver of the first row and the sender of the second.
    assert [(r.from_address[:8], r.to_address[:8]) for r in rows] == [
        ("BqCfmajD", "BQ72nSv9"),
        ("BQ72nSv9", "6GpvpHXB"),
        ("6GpvpHXB", "7uTT8Xi5"),
    ]


def test_top_level_transfer_keeps_address_case():
    rows = decode_transaction(load("top_level_transfer"), MINT)

    assert len(rows) == 1
    assert positions(rows) == [1]
    assert rows[0].value == 100000
    assert rows[0].from_address == "J6S8kJCAw1bscNfLD1eyt7uUkFExooaXkqPzvjk98dZ3"
    assert rows[0].to_address == "J95uU8JeFEGi9A5y3mHRNTM5nNkYSVM2RZ7twqJuYMyw"


@pytest.mark.parametrize("name", ["no_movement", "mint_creation"])
def test_names_the_mint_but_moves_nothing(name):
    assert decode_transaction(load(name), MINT) == []


@pytest.mark.parametrize(
    "name, mint, kind",
    [
        ("confidential_deposit_transfer", CONFIDENTIAL_MINT, "depositConfidentialTransfer"),
        ("confidential_withdraw", WITHDRAW_MINT, "withdrawConfidentialTransfer"),
    ],
)
def test_confidential_instruction_on_the_mint_stops(name, mint, kind):
    tx = load(name)

    with pytest.raises(SolanaDataError) as error:
        decode_transaction(tx, mint)

    assert signature(tx) in str(error.value)
    assert kind in str(error.value)


@pytest.mark.parametrize("name", ["confidential_deposit_transfer", "confidential_withdraw"])
def test_another_mints_confidential_instructions_are_ignored(name):
    assert decode_transaction(load(name), MINT) == []


# Invariant (S4)


def test_missing_movement_instruction_fails_the_invariant():
    tx = load("top_level_transfer")
    del tx["transaction"]["message"]["instructions"][1]

    with pytest.raises(SolanaDataError, match=f"{signature(tx)}: token account .* changed by"):
        decode_transaction(tx, MINT)


def test_post_balance_off_by_one_base_unit_fails():
    tx = load("top_level_transfer")
    entry = tx["meta"]["postTokenBalances"][1]["uiTokenAmount"]
    entry["amount"] = str(int(entry["amount"]) + 1)

    with pytest.raises(SolanaDataError, match=f"{signature(tx)}: token account .* changed by"):
        decode_transaction(tx, MINT)


def test_transient_account_that_no_longer_nets_to_zero_fails():
    tx = load("transient_account")
    moves = [
        parsed
        for group in tx["meta"]["innerInstructions"]
        for inner in group["instructions"]
        if isinstance(parsed := inner.get("parsed"), dict)
        and parsed["type"] == "transferChecked"
        and parsed["info"]["mint"] == MINT
    ]
    moves[-1]["info"]["tokenAmount"]["amount"] = "490832378"

    with pytest.raises(SolanaDataError, match=signature(tx)):
        decode_transaction(tx, MINT)


def plain_form(tx: dict[str, Any], mint: str, kind: str) -> dict[str, Any]:
    """Turn every Checked movement of `mint` into the plain form: no decimals, amount at the top."""
    for group in tx["meta"]["innerInstructions"]:
        for inner in group["instructions"]:
            parsed = inner.get("parsed")
            if isinstance(parsed, dict) and parsed["info"].get("mint") == mint:
                parsed["type"] = kind
                parsed["info"]["amount"] = parsed["info"].pop("tokenAmount")["amount"]
    return tx


def test_plain_burn_with_a_closed_account_decodes_to_one_row():
    rows = decode_transaction(load("plain_burn_close"), MINT)

    assert len(rows) == 1
    row = rows[0]
    assert row.block_number == 459717019
    assert row.log_index == (32 << 12) | 3
    assert row.from_address == "AmxGS1afu2HpW7LTtaC8SVYJJ5QV8dRtejbzP6hiGjpc"
    assert row.to_address == ZERO_ADDRESS
    assert row.value == 2423360


def test_plain_mint_to_decodes_like_mint_to_checked():
    checked = decode_transaction(load("mint_inner_second_mint"), MINT)
    tx = plain_form(load("mint_inner_second_mint"), MINT, "mintTo")

    assert decode_transaction(tx, MINT) == checked


def test_plain_burn_of_another_mint_is_ignored():
    tx = load("plain_burn_close")
    other = copy.deepcopy(
        next(
            ix
            for ix in tx["transaction"]["message"]["instructions"]
            if isinstance(ix.get("parsed"), dict) and ix["parsed"]["type"] == "burn"
        )
    )
    other["parsed"]["info"]["mint"] = WITHDRAW_MINT
    other["parsed"]["info"]["amount"] = "7"
    tx["transaction"]["message"]["instructions"].append(other)

    rows = decode_transaction(tx, MINT)

    assert len(rows) == 1
    assert rows[0].value == 2423360


@pytest.mark.parametrize("amount", ["-5", "1.5", "1_0", " 7", "", 7, 7.0, None])
def test_plain_amount_that_is_not_digits_is_a_data_error(amount):
    tx = load("plain_burn_close")
    for ix in tx["transaction"]["message"]["instructions"]:
        parsed = ix.get("parsed")
        if isinstance(parsed, dict) and parsed["type"] == "burn":
            parsed["info"]["amount"] = amount

    with pytest.raises(SolanaDataError, match=signature(tx)):
        decode_transaction(tx, MINT)


def test_plain_transfer_names_no_mint_so_the_invariant_stops():
    tx = plain_form(load("top_level_transfer"), MINT, "transfer")
    for ix in tx["transaction"]["message"]["instructions"]:
        parsed = ix.get("parsed")
        if isinstance(parsed, dict) and parsed["type"] == "transferChecked":
            info = parsed["info"]
            parsed["type"] = "transfer"
            info["amount"] = info.pop("tokenAmount")["amount"]
            info.pop("mint")

    with pytest.raises(SolanaDataError, match="changed by"):
        decode_transaction(tx, MINT)


def test_amounts_come_from_the_raw_string_not_ui_amount():
    tx = load("top_level_transfer")
    move = tx["transaction"]["message"]["instructions"][1]["parsed"]["info"]["tokenAmount"]
    move["uiAmount"] = 999.0
    move["uiAmountString"] = "999"

    assert decode_transaction(tx, MINT)[0].value == 100000


# Owners


def test_unknown_owner_raises_rather_than_guessing():
    tx = load("transient_account")
    for group in tx["meta"]["innerInstructions"]:
        group["instructions"] = [
            inner
            for inner in group["instructions"]
            if not (
                isinstance(inner.get("parsed"), dict)
                and inner["parsed"]["type"] == "initializeAccount3"
            )
        ]

    with pytest.raises(SolanaDataError, match="no owner for token account"):
        decode_transaction(tx, MINT)


def test_pre_and_post_owner_differing_raises():
    tx = load("top_level_transfer")
    tx["meta"]["postTokenBalances"][1]["owner"] = "11111111111111111111111111111111"

    with pytest.raises(SolanaDataError, match="changed owner"):
        decode_transaction(tx, MINT)


def test_owner_equal_to_the_mint_address_stays_a_transfer(store):
    tx = load("top_level_transfer")
    for key in ("preTokenBalances", "postTokenBalances"):
        tx["meta"][key][1]["owner"] = MINT

    rows = decode_transaction(tx, MINT)
    store.write_range("solana", rows, {}, rows[0].block_number)

    assert rows[0].to_address == MINT
    assert rows[0].from_address != ZERO_ADDRESS
    assert store.minted_and_burned("solana", rows[0].block_number) == (0, 0)


# Instructions


def test_unseen_confidential_type_naming_the_mint_raises():
    tx = load("no_movement")
    tx["transaction"]["message"]["instructions"][0]["parsed"]["type"] = "someNewConfidentialThing"

    with pytest.raises(SolanaDataError, match="confidential instruction someNewConfidentialThing"):
        decode_transaction(tx, MINT)


@pytest.mark.parametrize(
    "kind", ["initializeConfidentialTransferMint", "updateConfidentialTransferMint"]
)
def test_confidential_mint_setup_does_not_raise(kind):
    tx = load("mint_creation")
    for instruction in tx["transaction"]["message"]["instructions"]:
        parsed = instruction.get("parsed")
        if isinstance(parsed, dict) and parsed["type"] == "initializeConfidentialTransferMint":
            parsed["type"] = kind

    assert decode_transaction(tx, MINT) == []


def partially_decoded(*accounts: str) -> dict[str, Any]:
    return {"accounts": list(accounts), "data": "3", "programId": TOKEN_2022, "stackHeight": 1}


def test_partially_decoded_token_2022_instruction_with_the_mint_raises():
    tx = load("no_movement")
    tx["transaction"]["message"]["instructions"][0] = partially_decoded(MINT)

    with pytest.raises(SolanaDataError, match=signature(tx)):
        decode_transaction(tx, MINT)


def test_partially_decoded_token_2022_instruction_without_the_mint_is_ignored():
    tx = load("no_movement")
    tx["transaction"]["message"]["instructions"][0] = partially_decoded(CONFIDENTIAL_MINT)

    assert decode_transaction(tx, MINT) == []


# Fields


@pytest.mark.parametrize("field", ["transactionIndex", "blockTime"])
def test_missing_field_raises(field):
    tx = load("top_level_transfer")
    del tx[field]

    with pytest.raises(SolanaDataError, match=field):
        decode_transaction(tx, MINT)


def test_transaction_index_of_2_to_the_19_raises():
    tx = load("top_level_transfer")
    tx["transactionIndex"] = 1 << 19

    with pytest.raises(SolanaDataError, match="transactionIndex"):
        decode_transaction(tx, MINT)


def pad_to(tx: dict[str, Any], count: int) -> None:
    """Put no-op instructions in front so the OUSD transfer sits at flattened position count - 1."""
    instructions = tx["transaction"]["message"]["instructions"]
    filler = copy.deepcopy(instructions[-1])  # An unparsed ComputeBudget instruction.
    assert "parsed" not in filler
    instructions[:0] = [copy.deepcopy(filler) for _ in range(count - 2)]


def test_position_of_4096_raises():
    tx = load("top_level_transfer")  # The transfer is at position 1, with 5 instructions.
    pad_to(tx, 4097 - 3)

    with pytest.raises(SolanaDataError, match="instructions"):
        decode_transaction(tx, MINT)


def test_largest_index_and_position_fit_a_signed_32_bit_integer():
    tx = load("top_level_transfer")
    pad_to(tx, 4096 - 3)  # 4096 instructions in all: the transfer lands at position 4094.
    tx["transactionIndex"] = (1 << 19) - 1
    # Put the transfer last, at position 4095.
    instructions = tx["transaction"]["message"]["instructions"]
    move = next(
        i
        for i in instructions
        if isinstance(i.get("parsed"), dict) and i["parsed"]["type"] == "transferChecked"
    )
    instructions.remove(move)
    instructions.append(move)

    row = decode_transaction(tx, MINT)[0]

    assert row.log_index & 0xFFF == 4095
    assert row.log_index == 2**31 - 1


# Facts the plain-transfer reasoning rests on


def instruction_types(name: str) -> set[str]:
    return {
        i["parsed"]["type"]
        for i in load(name)["transaction"]["message"]["instructions"]
        if isinstance(i.get("parsed"), dict)
    }


def test_mint_creation_initializes_transfer_hook_and_pausable():
    types = instruction_types("mint_creation")

    assert {"initializeTransferHook", "initializePausableConfig"} <= types


def extension_names(name: str) -> set[str]:
    info = load(name)["value"]["data"]["parsed"]["info"]
    return {extension["extension"] for extension in info["extensions"]}


def test_mint_has_no_transfer_fee_or_confidential_mint_and_burn():
    extensions = extension_names("mint_account")

    assert "transferFeeConfig" not in extensions
    assert "confidentialMintBurn" not in extensions
    assert "scaledUiAmountConfig" not in extensions


def test_token_account_has_the_extensions_that_require_the_mint():
    assert {"transferHookAccount", "pausableAccount", "immutableOwner"} <= extension_names(
        "token_account"
    )


# Store contract


def test_shared_position_rows_write_as_two_and_rewrite_unchanged(store):
    rows = decode_transaction(load("shared_position_a"), MINT) + decode_transaction(
        load("shared_position_b"), MINT
    )

    store.write_range("solana", rows, {}, 463296214)
    store.write_range("solana", rows, {}, 463296214)

    assert store.transfer_count("solana") == 2


def test_minted_and_burned_match_the_fixtures(store):
    mint = decode_transaction(load("mint_inner_second_mint"), MINT)
    burn = decode_transaction(load("burn_inner_second_mint"), MINT)

    store.write_range("solana", burn, {}, 456218249)
    store.write_range("solana", mint, {}, 459708395)

    assert store.minted_and_burned("solana", 459708395) == (30315020000, 4917380000)


def test_malformed_shape_raises_data_error():
    tx = load("top_level_transfer")
    del tx["transaction"]["message"]["instructions"][1]["parsed"]["info"]["tokenAmount"]

    with pytest.raises(SolanaDataError, match="malformed"):
        decode_transaction(tx, MINT)


def test_two_owners_for_one_account_raise():
    tx = load("transient_account")
    tx["meta"]["postTokenBalances"].append(
        {**tx["meta"]["postTokenBalances"][0], "owner": "11111111111111111111111111111111"}
    )

    with pytest.raises(SolanaDataError, match="twice"):
        decode_transaction(tx, MINT)
