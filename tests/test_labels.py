"""Checks the real labels file. Only the dbt tests at the end run dbt. Nothing uses a network."""

import csv
import re
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from dbt_helpers import build_marts, failed_tests, invoke_dbt, write_raw
from ousd import publish
from ousd.chains import REQUIRED_CHAINS

ROOT = Path(__file__).resolve().parent.parent
LABELS = ROOT / "labels" / "labels.csv"
HEADER = [
    "chain",
    "address",
    "entity",
    "category",
    "source_type",
    "source_url",
    "confidence",
    "date_checked",
]
CATEGORIES = {"issuer", "issuer_route", "system", "dex", "lending", "exchange", "exchange_linked"}
CONFIDENCES = {"high", "medium"}
SOURCE_TYPES = {
    "explorer_tag",
    "project_docs",
    "company_docs",
    "official_statement",
    "published_research",
    "onchain_metadata",
    "derived_rule",
}
EVM_ADDRESS = re.compile(r"^0x[0-9a-f]{40}$")
SOLANA_ADDRESS = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
# A named label's first word must be one of these. A list of people's names can't be written, so
# this makes adding any new name a deliberate, reviewed edit. Never add a private individual.
ORGANIZATIONS = {
    "0x",
    "Bridge",
    "Coinbase",
    "KyberSwap",
    "LI.FI",
    "OKX",
    "Orca",
    "Relay",
    "Sentora",
    "Tempo",
    "Uniswap",
}
SOLANA_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"


def read_labels():
    with LABELS.open(newline="") as handle:
        return list(csv.DictReader(handle))


ROWS = read_labels()


def row_id(row):
    return f"{row['chain']}:{row['address']}"


each_row = pytest.mark.parametrize("row", ROWS, ids=row_id)


def test_header_is_the_contract():
    with LABELS.open(newline="") as handle:
        assert next(csv.reader(handle)) == HEADER


def test_each_chain_and_address_is_unique():
    keys = [(row["chain"], row["address"]) for row in ROWS]
    assert len(keys) == len(set(keys))


@each_row
def test_row_has_valid_enums_and_date(row):
    assert row["chain"] in REQUIRED_CHAINS
    assert row["source_url"]
    assert row["category"] in CATEGORIES
    assert row["confidence"] in CONFIDENCES
    assert row["source_type"] in SOURCE_TYPES
    assert date.fromisoformat(row["date_checked"]) <= datetime.now(UTC).date()


@each_row
def test_address_format_matches_chain(row):
    pattern = SOLANA_ADDRESS if row["chain"] == "solana" else EVM_ADDRESS
    assert pattern.match(row["address"])


def test_address_patterns_reject_the_wrong_form():
    assert not EVM_ADDRESS.match("0x" + "A" * 40)
    assert not EVM_ADDRESS.match("0x" + "a" * 39)
    assert SOLANA_ADDRESS.match(SOLANA_WALLET)
    assert not SOLANA_ADDRESS.match("0x" + "a" * 40)


def test_solana_addresses_are_never_lowercased():
    solana = [row["address"] for row in ROWS if row["chain"] == "solana"]
    assert all(address != address.lower() for address in solana)


@each_row
def test_only_derived_rule_rows_lack_a_web_source(row):
    if row["source_type"] != "derived_rule":
        assert row["source_url"].startswith("https://")


@each_row
def test_derived_rule_has_no_entity_and_points_at_a_rule_here(row):
    if row["source_type"] == "derived_rule":
        assert not row["entity"]
        assert row["source_url"] == publish.UNNAMED_RULE_REFERENCE
        path, _, section = row["source_url"].partition("#")
        lines = (ROOT / path).read_text().lower().splitlines()
        slugs = {line.lstrip("#").strip().replace(" ", "-") for line in lines if line[:1] == "#"}
        assert section in slugs


def test_no_label_leads_to_a_brainstorm():
    """That document names a firm and a wallet by inference, so a label can't point there."""
    assert not [row for row in ROWS if "brainstorm" in row["source_url"]]


def test_the_unnamed_cluster_rule_names_nobody():
    rule = publish._read_unnamed_rule((ROOT / "labels" / "README.md").read_text())
    named = {row["entity"].split()[0] for row in ROWS if row["entity"]} | ORGANIZATIONS
    # Tempo is both an entity's first word and a chain, and the rule mentions no chain either.
    assert not [name for name in named if re.search(rf"\b{re.escape(name)}\b", rule)]
    assert "hub" in rule
    assert not publish._wallet_shapes(rule)


@each_row
def test_a_named_label_passes_the_publish_guard(row):
    if row["entity"]:
        hosts = publish._read_source_hosts((ROOT / "labels" / "README.md").read_text())
        publish._refuse_bad_source(row, hosts)


def test_an_address_has_one_category_across_chains():
    """A rule treats an address one way. Being labeled on some chains and not others is coverage,
    but a different category for one address means two rules were applied."""
    seen: dict[str, str] = {}
    for row in ROWS:
        assert seen.setdefault(row["address"].lower(), row["category"]) == row["category"], row


@pytest.mark.parametrize(
    "address",
    ["0x8458377a025da58e9cb547c979d5002c822a05cb", "0xb0d0b9b8ab03cbac16cdf9e59bc5a1a2ade55da2"],
)
def test_a_collection_wallet_is_an_unnamed_route_row_on_each_evm_chain(address):
    rows = {row["chain"]: row for row in ROWS if row["address"] == address}
    assert sorted(rows) == ["base", "ethereum", "tempo"]
    for row in rows.values():
        assert row["entity"] == ""
        assert row["category"] == "issuer_route"
        assert row["source_type"] == "derived_rule"
        assert row["confidence"] == "medium"


def test_the_rule_states_collection_wallets_and_leaves_out_pass_through():
    rule = publish._read_unnamed_rule((ROOT / "labels" / "README.md").read_text())
    assert "Collection wallets take money from many senders" in rule
    assert "send every outgoing transfer to the hub" in rule
    assert "hold almost no balance" in rule
    assert "from a single sender stays unlabeled" in rule


def test_relay_depository_cites_the_api_its_docs_page_loads():
    rows = [row for row in ROWS if row["entity"] == "Relay Depository"]
    assert len(rows) == 3
    assert {row["source_url"] for row in rows} == {"https://api.relay.link/chains"}


def test_settler_labels_cite_their_creator():
    readme = (ROOT / "labels" / "README.md").read_text()
    rows = [row for row in ROWS if row["entity"] == "0x Settler"]
    assert len(rows) == 3
    assert all(row["address"] in row["source_url"] for row in rows)
    assert "deployer.zeroexprotocol.eth" in publish._read_legend(readme)["reading_a_label"]


def test_the_legend_asks_for_no_address_it_does_not_publish():
    legend = publish._read_legend((ROOT / "labels" / "README.md").read_text())
    how = {row["source_type"]: row["how_to_check"] for row in legend["source_types"]}
    assert "labels/labels.csv" in how["derived_rule"]
    assert "address's transfers" not in how["derived_rule"]
    assert not [row for row in how.values() if "find the address" in row]


@each_row
def test_entity_is_an_organization_not_a_person(row):
    if row["entity"]:
        assert row["entity"].split()[0] in ORGANIZATIONS


@pytest.mark.parametrize(
    "chain",
    [
        "tempo",
        "ethereum",
        "base",
        pytest.param(
            "solana",
            marks=pytest.mark.xfail(
                strict=True,
                reason="No public source yet names Solana's mint recipient, and the rule forbids "
                "naming it by inference. Passing here means a source was found: drop this mark.",
            ),
        ),
    ],
)
def test_each_chain_has_an_issuer_row(chain):
    assert any(row["chain"] == chain and row["category"] == "issuer" for row in ROWS)


def test_legend_covers_every_source_type():
    readme = (ROOT / "labels" / "README.md").read_text()
    for source_type in SOURCE_TYPES:
        assert f"| `{source_type}` |" in readme


def label(**changes):
    row = {
        "chain": "tempo",
        "address": "0x" + "a" * 40,
        "entity": "Example",
        "category": "dex",
        "source_type": "project_docs",
        "source_url": "https://example.com",
        "confidence": "high",
        "date_checked": "2026-11-04",
    }
    return {**row, **changes}


def test_real_file_builds_with_empty_entity_as_null(tmp_path):
    conn = build_marts(tmp_path, [], ROWS, {}, select=["stg_labels"])
    try:
        rows = conn.execute(
            "select chain, address, entity, source_type, date_checked from main.stg_labels"
        ).fetchall()
    finally:
        conn.close()
    assert {
        (chain, address): (entity, kind, checked) for chain, address, entity, kind, checked in rows
    } == {
        (row["chain"], row["address"]): (
            row["entity"] or None,
            row["source_type"],
            date.fromisoformat(row["date_checked"]),
        )
        for row in ROWS
    }


def test_solana_address_keeps_its_case_through_staging(tmp_path):
    labels = [label(chain="solana", address=SOLANA_WALLET)]
    conn = build_marts(tmp_path, [], labels, {}, select=["stg_labels"])
    try:
        assert conn.execute("select address from main.stg_labels").fetchall() == [(SOLANA_WALLET,)]
    finally:
        conn.close()


@pytest.mark.parametrize(
    ("labels", "failing"),
    [
        ([label(category="bridge")], "accepted_values_stg_labels_category"),
        ([label(confidence="low")], "accepted_values_stg_labels_confidence"),
        ([label(source_type="rumor")], "accepted_values_stg_labels_source_type"),
        ([label(chain="mars")], "accepted_values_stg_labels_chain"),
        ([label(chain="")], "not_null_stg_labels_chain"),
        ([label(address="")], "not_null_stg_labels_address"),
        ([label(source_url="")], "not_null_stg_labels_source_url"),
        ([label(category="")], "not_null_stg_labels_category"),
        ([label(source_type="")], "not_null_stg_labels_source_type"),
        ([label(confidence="")], "not_null_stg_labels_confidence"),
        ([label(), label()], "assert_unique_label"),
    ],
    ids=[
        "category",
        "confidence",
        "source_type",
        "chain",
        "no_chain",
        "no_address",
        "no_url",
        "no_category",
        "no_source_type",
        "no_confidence",
        "duplicate",
    ],
)
def test_dbt_rejects_a_bad_label(tmp_path, labels, failing):
    write_raw(tmp_path / "ousd.duckdb", [], {})
    result = invoke_dbt(tmp_path, labels, select=["stg_labels"])
    assert not result.success
    assert any(name.startswith(failing) for name in failed_tests(result))


def test_an_exchange_linked_wallet_is_never_named():
    """Funding and label sites can't name a wallet, so this category stays an unnamed cluster."""
    linked = [row for row in ROWS if row["category"] == "exchange_linked"]
    assert linked
    assert all(not row["entity"] and row["source_type"] == "derived_rule" for row in linked)


def test_every_named_exchange_label_is_an_explorer_tag():
    exchanges = [row for row in ROWS if row["category"] == "exchange"]
    assert {row["chain"] for row in exchanges} >= {"ethereum", "base", "solana"}
    assert all(row["source_type"] == "explorer_tag" and row["entity"] for row in exchanges)
