# Implementation plan

**Goal:** a first public version.
**Rule:** if time runs short, cut views. Never cut reconciliation, tests or honesty.

Requirements (R1 to R16) are in `docs/PRD.md`. Structure is in `docs/architecture.md`.

## Phase 1: trustworthy core

**Delivers:** all four chains ingested and reconciled.

| Unit | Paths |
|---|---|
| 1.1 Ingestion foundation: sources, store, reorg repair, per-chain reconciliation | `pipeline/`, `tests/`, `Makefile`, `pyproject.toml` |
| 1.2 Base source, using `BASE_RPC_URL` | `pipeline/ousd/sources.py`, `chains.py`, `http.py`, `cli.py`, `README.md`, tests |
| 1.3 Solana source, using `SOLANA_RPC_URL` | `pipeline/ousd/solana.py`, `cli.py`, `README.md`, `tests/fixtures/solana/`, `docs/build-log.md`, tests |
| 1.4 Full cross-chain reconciliation against Bridge | `pipeline/ousd/reconcile.py`, `probes.py`, `store.py`, `sources.py`, `chains.py`, `cli.py`, `solana.py`, `README.md`, `docs/build-log.md`, tests |

**Done when:** every chain reconciles to the base unit, the cross-chain check passes within a stated tolerance, and `make check` passes in CI.

## Phase 2: insight models

**Delivers:** the marts behind the first three views, and an orchestrated run.

| Unit | Paths |
|---|---|
| 2.1 Test the PRD's metric definitions against real data, and settle thresholds | `docs/brainstorms/` |
| 2.2 dbt project and staging models | `dbt/` staging |
| 2.3 Labels file from published sources | `labels/` |
| 2.4 `mart_supply_journey` | `dbt/` marts |
| 2.5 `mart_activity_waterfall`, including the fee rule | `dbt/` marts |
| 2.6 `mart_chain_roles` and `mart_reconciliation` | `dbt/` marts |
| 2.7 Dagster assets, schedule and blocking checks | `pipeline/dagster/` |
| 2.8 Publish step and dataset schema | `pipeline/ousd/publish.py` |

**Done when:** one command runs ingest to publish, a failed check stops publishing, and every metric definition is documented and defensible.

**Build order:** 2.8 before 2.7, so orchestration wraps real functions. Detail is in `docs/plans/2026-11-03-001-insight-models-plan.md`.

**Insight check, on Tempo and part of Ethereum only:**

> On Tempo, which holds about two-thirds of OUSD, 77% of supply has sat still for at least two weeks in wallets of $1M or more, and transfers under $1M moved only $4.6M in the last week, under 1% of supply. So far this looks mostly like balance-sheet supply, with early everyday use rising from a low base.

The data supports this for Tempo, and not yet for all chains: Base and Solana are 19% of supply and were where first-week trading happened. See `docs/brainstorms/2026-11-03-adoption-metrics-requirements.md`.

## Phase 3: first public version

**Delivers:** the site with verdict, trust strip, views A, B and E, and methodology.

| Unit | Paths |
|---|---|
| 3.1 Next.js scaffold, tokens and dataset loader | `web/` foundation |
| 3.2 Verdict block, KPI row and trust strip | `web/` components |
| 3.3 Views A, B and E | `web/` views |
| 3.4 Methodology page | `web/`, `docs/methodology.md` |
| 3.5 README and repo polish for outside readers | `README.md`, `docs/` |
| 3.6 Mobile, accessibility and browser acceptance | Fixes only |

**Done when:** it builds and renders from a published dataset, passes on mobile, and matches `docs/design-system.md`.

## Phase 4: review and release

1. Trace each public claim to data or a source.
2. Review the whole codebase.
3. Fix what those find.
4. Write a summary note and the announcement.

**Done when:** the maintainer approves the release.

## Phase 5: after the first release

Views C (partners), D (peers) and F (economics), the weekly note, CSV downloads and hosted schedules. Partners are named from public evidence only.
