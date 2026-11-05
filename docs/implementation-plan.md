# Implementation plan

**Goal:** a first public version.
**Rule:** if time runs short, cut views. Never cut reconciliation, tests or honesty.

Requirements (R1 to R16) are in `docs/PRD.md`. Structure is in `docs/architecture.md`. The PRD's phase table numbers phases differently; this file is the one to follow for what is built when.

| Phase | Status |
|---|---|
| 1. Trustworthy core | Done |
| 2. Insight models | Done |
| 3. First public version | Done. Not deployed |
| 4. Review and release | In progress: the dashboard refurbish, below |
| 5. After the first release | Not started |

## Phase 1: trustworthy core (done)

**Delivers:** all four chains ingested and reconciled.

| Unit | |
|---|---|
| 1.1 Ingestion foundation: sources, store, reorg repair, per-chain reconciliation | Done |
| 1.2 Base source, using `BASE_RPC_URL` | Done |
| 1.3 Solana source, using `SOLANA_RPC_URL` | Done |
| 1.4 Full cross-chain reconciliation against Bridge | Done |

**Done when:** every chain reconciles to the base unit, the cross-chain check passes within a stated tolerance, and `make check` passes in CI.

**Result:** the first full reconciliation passed on 2026-11-04 at 09:24 UTC, with every difference 0 base units on all four chains and Bridge's total matching on the first attempt. A second run passed a minute later. The figures, the problems found on the way and the known limits are in `docs/build-log.md`.

## Phase 2: insight models (done)

**Delivers:** the marts behind the first three views, and an orchestrated run.

| Unit | |
|---|---|
| 2.1 Test the PRD's metric definitions against real data, and settle thresholds | Done |
| 2.2 dbt project and staging models | Done |
| 2.3 Labels file from published sources | Done |
| 2.4 `mart_supply_journey` | Done |
| 2.5 `mart_activity_waterfall`, including the fee rule | Done |
| 2.6 `mart_chain_roles` and `mart_reconciliation` | Done |
| 2.7 Dagster assets, schedule and blocking checks | Done |
| 2.8 Publish step and dataset schema | Done |

**Done when:** one command runs ingest to publish, a failed check stops publishing, and every metric definition is documented and defensible.

**Result:** `make run` runs the whole path, and the seven checks block publishing, tested with failing inputs. Metric definitions and thresholds are in `docs/PRD.md` section 7 and `docs/methodology.md`. Detail is in `docs/plans/2026-11-03-001-insight-models-plan.md`. The Dagster schedule ships stopped. A week of scheduled runs is not part of this phase's result, as nothing is hosted yet.

**Insight check, read on 2026-11-03, on Tempo and part of Ethereum only:**

> On Tempo, which holds about two-thirds of OUSD, 77% of supply has sat still for at least two weeks in wallets of $1M or more, and transfers under $1M moved only $4.6M in the last week, under 1% of supply. So far this looks mostly like balance-sheet supply, with early everyday use rising from a low base.

The data supports this for Tempo, and not yet for all chains: Base and Solana were 19% of supply and were where first-week trading happened. These figures will have moved since. See `docs/brainstorms/2026-11-03-adoption-metrics-requirements.md`.

## Phase 3: first public version (done)

**Delivers:** the site with verdict, trust strip, views A, B and E, and methodology. The plan, with the acceptance checks for each unit, is `docs/plans/2026-11-04-001-first-public-version-plan.md`.

| Unit | Status |
|---|---|
| 3.1a Scaffold and tooling | Done |
| 3.1b Tokens, shell and shared components | Done |
| 3.1c Dataset loader, sample data, states and page frame | Done |
| 3.2 Verdict block, KPI row and trust strip | Done |
| 3.3a View A, supply journey | Done |
| 3.3b View B, real activity | Done |
| 3.3c View E, chain roles | Done |
| 3.4 Methodology page | Done |
| 3.5 README and docs for outside readers | Done |
| 3.6 Mobile, accessibility and browser acceptance | Done |

**Done when:** it builds and renders from a published dataset, passes on mobile, and matches `docs/design-system.md`.

**Result:** it builds and renders from a real dataset on a local build, and passes the browser acceptance checks at phone and desktop widths. The figures and the problems found are in `docs/build-log.md`. Nothing is deployed.

## Phase 4: review and release (next)

**Before the review: dashboard refurbish.** On review, the maintainer found the site too wordy and not intuitive. This step turns the main page into a dashboard with legends, keeping every finding visible and changing no number. It comes first because the review should read the page people will see. The plan, with the acceptance checks for each unit, is `docs/plans/2026-11-04-002-dashboard-refurbish-plan.md`.

| Unit | Status |
|---|---|
| U1 Shared components: card, info popover, pins and notes, data toggle, chain filter, marker and legend | Done, #50 |
| U2 First screen | Done, #52 |
| U3 Supply views, with the chain filter mounted | Done, #53. Exchange-linked supply inside placed came first, in #51 |
| U4 Activity views | Done, #54 |
| U5 Velocity and chain views, then the maintainer's whole-page review | Built, in review. The whole-page review follows |
| U6 Acceptance | Not started |

**Done when:** U6's scripted checks pass on a real dataset, and the maintainer has reviewed the whole page. The headline's final wording is the maintainer's call, and stays open until then.

Then:

1. Trace each public claim to data or a source.
2. Review the whole codebase.
3. Fix what those find.
4. Write a summary note and the announcement.

**Done when:** the maintainer approves the release.

## Phase 5: after the first release

Views C (partners), D (peers) and F (economics), the weekly note, CSV downloads and hosted schedules. Partners are named from public evidence only.
