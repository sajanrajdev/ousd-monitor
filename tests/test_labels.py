"""Checks the real labels file. Only the dbt tests at the end run dbt. Nothing uses a network."""

import csv
import re
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from dbt_helpers import build_marts, failed_tests, invoke_dbt, write_raw
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
CATEGORIES = {"issuer", "issuer_route", "system", "dex", "lending", "exchange"}
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
ORGANIZATIONS = {"Bridge", "Coinbase", "Sentora", "Tempo", "Uniswap"}
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
        path, _, section = row["source_url"].partition("#")
        lines = (ROOT / path).read_text().lower().splitlines()
        slugs = {line.lstrip("#").strip().replace(" ", "-") for line in lines if line[:1] == "#"}
        assert section in slugs


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
