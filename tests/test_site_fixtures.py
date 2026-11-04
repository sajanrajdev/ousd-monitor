"""The site's sample datasets stay true to what the pipeline would write, and can't pass as real."""

import json
import shutil
import subprocess
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
import yaml
from ousd import publish as publisher
from ousd.chains import REQUIRED_CHAINS
from ousd.publish import DAY_ZERO, VELOCITY_DEFINITIONS
from ousd.verdict import known_limits

REPO = Path(__file__).resolve().parent.parent
SAMPLES = REPO / "web" / "fixtures" / "dataset"
README = (REPO / "labels" / "README.md").read_text()
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
MAKE = shutil.which("make") or "make"
PACKAGE_JSON = '{"packageManager": "pnpm@1.2.3", "engines": {"node": "^22.12 || ^24"}}\n'


def read(sample: str, name: str) -> dict[str, Any]:
    payload: dict[str, Any] = json.loads((SAMPLES / sample / name).read_text())
    return payload


@pytest.fixture(params=["complete", "partial"])
def sample(request: pytest.FixtureRequest) -> str:
    name: str = request.param
    return name


def test_each_file_passes_its_schema(sample: str) -> None:
    for name in JSON_FILES:
        publisher._validate(name, read(sample, name))


def test_nothing_in_a_sample_would_be_refused_on_the_way_out(sample: str) -> None:
    payloads = {name: read(sample, name) for name in JSON_FILES}
    tabular = {name: (SAMPLES / sample / name).read_bytes() for name in CSV_FILES}

    publisher._refuse_unsafe_dataset(payloads, tabular)


def test_known_limits_match_the_pipeline_for_this_coverage(sample: str) -> None:
    manifest = read(sample, "manifest.json")
    summary = read(sample, "summary.json")

    limits = known_limits(
        int(manifest["definitions"]["large_transfer_base_units"]),
        chains_without_issuer_row=manifest["coverage"]["chains_without_issuer_row"],
        chains_not_issuer_labeled=[
            row["chain"] for row in summary["kpis"] if not row["issuer_labeled"]
        ],
        chains_missing=manifest["coverage"]["chains_missing"],
        preview=manifest["preview"],
    )

    assert summary["known_limits"] == [{"id": limit.id, "text": limit.text} for limit in limits]


def test_the_legend_and_rule_match_the_labels_readme(sample: str) -> None:
    labels = read(sample, "labels.json")

    assert labels["source_legend"] == publisher._read_legend(README)
    assert labels["unnamed_clusters"]["rule"] == publisher._read_unnamed_rule(README)


def test_every_source_type_in_a_sample_is_in_its_legend(sample: str) -> None:
    labels = read(sample, "labels.json")
    known = {row["source_type"] for row in labels["source_legend"]["source_types"]}

    assert {row["source_type"] for row in labels["data"]} <= known


def test_a_sample_carries_every_mark_of_one(sample: str) -> None:
    assert (SAMPLES / sample / "FIXTURE").exists()
    manifest = read(sample, "manifest.json")
    assert set(manifest["git_commit"]) == {"0"}


def test_sample_names_are_invented_and_their_links_go_nowhere_real(sample: str) -> None:
    for row in read(sample, "labels.json")["data"]:
        assert row["entity"].startswith("Sample ")
        assert row["source_url"].startswith("https://example.com/")


def test_partial_is_the_shape_make_preview_writes() -> None:
    manifest = read("partial", "manifest.json")

    assert manifest["preview"] is True
    assert manifest["dataset_version"].startswith("preview-")
    assert manifest["coverage"]["chains_included"] == ["tempo", "ethereum"]
    assert {check["status"] for check in manifest["checks"]} == {"passed", "skipped"}


def test_complete_has_the_awkward_cases_the_views_must_handle() -> None:
    manifest = read("complete", "manifest.json")
    kpis = read("complete", "summary.json")["kpis"]
    journey = read("complete", "journey.json")["data"]
    activity = read("complete", "activity.json")["data"]

    assert manifest["coverage"]["chains_included"] == list(REQUIRED_CHAINS)
    assert any(
        row["velocity_bps"] is not None and row["velocity_bps"] > row["headline_velocity_bps"]
        for row in kpis
    )
    assert any(row["velocity_bps"] is None for row in kpis)
    assert any(row["headline_value"] == "0" for row in activity)
    assert len({row["day"] for row in kpis}) > 1
    assert any(not row["issuer_labeled"] for row in journey)
    assert any(int(row["total_supply"]) > 2**53 for row in journey)


def test_the_documented_defaults_are_what_the_marts_are_built_with() -> None:
    project = yaml.safe_load((REPO / "dbt" / "dbt_project.yml").read_text())["vars"]
    definitions = read("complete", "manifest.json")["definitions"]

    for name in (
        "placed_min_base_units",
        "large_transfer_base_units",
        "active_dust_base_units",
        "active_secondary_base_units",
        "clean_tx_min_base_units",
    ):
        assert definitions[name] == str(project[name])
    assert definitions["placed_days"] == project["placed_days"]
    assert definitions["velocity"] == VELOCITY_DEFINITIONS
    first_day = DAY_ZERO + timedelta(days=project["placed_days"])
    assert definitions["journey_first_day"] == first_day.isoformat()
    site_constants = (REPO / "web" / "lib" / "definitions.ts").read_text()
    assert f'DAY_ZERO = "{DAY_ZERO.isoformat()}"' in site_constants


def test_the_site_lists_the_real_token_contracts() -> None:
    site_constants = (REPO / "web" / "lib" / "definitions.ts").read_text()

    for address in publisher._token_contracts():
        assert f'"{address}"' in site_constants


@pytest.fixture
def make_copy(tmp_path: Path) -> Path:
    shutil.copy(REPO / "Makefile", tmp_path / "Makefile")
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "package.json").write_text(PACKAGE_JSON)
    return tmp_path


def dry_run(copy: Path, target: str) -> str:
    result = subprocess.run(
        [MAKE, "-n", target], cwd=copy, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0
    return result.stdout


def test_check_builds_both_samples_and_never_a_release(make_copy: Path) -> None:
    output = dry_run(make_copy, "check")

    assert "OUSD_DATASET_DIR=fixtures/dataset/complete" in output
    assert "OUSD_DATASET_DIR=fixtures/dataset/partial" in output
    assert "run build complete" in output
    assert "run build partial" in output
    assert "run release" not in output


def test_build_uses_the_default_path(make_copy: Path) -> None:
    output = dry_run(make_copy, "build")

    assert "run build" in output
    assert "OUSD_DATASET_DIR" not in output


def test_release_is_its_own_step_and_loads_no_env(make_copy: Path) -> None:
    (make_copy / ".env").write_text("")

    output = dry_run(make_copy, "web-release")

    assert "run release" in output
    assert ".env" not in output
