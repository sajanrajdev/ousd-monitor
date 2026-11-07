import itertools
from typing import Any

import pytest
from ousd.chains import REQUIRED_CHAINS
from ousd.reconcile import exit_code, overall_status
from ousd.store import Status

# The decision tables. See "What a full pass is" in the reconciliation plan.

ALL_PASS: dict[str, Status] = dict.fromkeys(REQUIRED_CHAINS, "pass")


@pytest.mark.parametrize(
    ("chains", "bridge", "status", "code"),
    [
        (ALL_PASS, "pass", "pass", 0),
        ({**ALL_PASS, "base": "unchecked"}, "pass", "unchecked", 3),
        ({**ALL_PASS, "base": "fail"}, "pass", "fail", 1),
        ({**ALL_PASS, "base": "fail", "tempo": "unchecked"}, "pass", "fail", 1),
        (ALL_PASS, "unchecked", "unchecked", 3),
        (ALL_PASS, "fail", "fail", 1),
        ({**ALL_PASS, "base": "unchecked"}, "fail", "fail", 1),
    ],
)
def test_the_run_decision_table(chains, bridge, status, code):
    assert overall_status(REQUIRED_CHAINS, chains, bridge) == status
    assert exit_code(status) == code


def test_all_pass_over_three_chains_is_never_a_pass():
    three = REQUIRED_CHAINS[:3]

    chains: dict[str, Status] = dict.fromkeys(three, "pass")

    status = overall_status(three, chains, "pass")

    assert status == "unchecked"
    assert exit_code(status) == 3
    # Nor can a fourth result rescue a scope that didn't include it.
    assert overall_status(three, ALL_PASS, "pass") == "unchecked"


def test_a_scope_of_four_with_a_result_missing_is_not_a_pass():
    without_base = {name: status for name, status in ALL_PASS.items() if name != "base"}

    assert overall_status(REQUIRED_CHAINS, without_base, "pass") == "unchecked"


def test_an_empty_list_of_chains_is_not_vacuously_a_pass():
    assert overall_status((), {}, "pass") == "unchecked"
    assert overall_status(REQUIRED_CHAINS, {}, "pass") == "unchecked"


def test_a_fail_outside_the_required_chains_still_fails():
    assert overall_status(REQUIRED_CHAINS, {**ALL_PASS, "testnet": "fail"}, "pass") == "fail"
    assert overall_status(("tempo",), {"tempo": "fail"}, "unchecked") == "fail"


def test_a_status_it_does_not_know_is_never_a_pass():
    unknown: Any = "passed"

    assert overall_status(REQUIRED_CHAINS, {**ALL_PASS, "base": unknown}, "pass") == "unchecked"
    assert overall_status(REQUIRED_CHAINS, ALL_PASS, unknown) == "unchecked"
    with pytest.raises(KeyError):
        exit_code(unknown)


def test_exit_zero_appears_only_when_every_part_passes():
    statuses: tuple[Status, ...] = ("pass", "fail", "unchecked")
    seen = set()

    for *parts, bridge in itertools.product(statuses, repeat=len(REQUIRED_CHAINS) + 1):
        chains = dict(zip(REQUIRED_CHAINS, parts, strict=True))
        status = overall_status(REQUIRED_CHAINS, chains, bridge)
        code = exit_code(status)
        seen.add(code)
        everything = [*parts, bridge]
        assert (code == 0) == all(part == "pass" for part in everything)
        assert (code == 1) == ("fail" in everything)

    assert seen == {0, 1, 3}
