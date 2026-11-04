---
title: "feat: First public version of the site (Phase 3, units 3.1 to 3.6)"
type: feat
status: active
date: 2026-11-04
origin: docs/brainstorms/2026-11-03-adoption-metrics-requirements.md
---

# feat: First public version of the site (Phase 3, units 3.1 to 3.6)

## Overview

Build the static site: verdict, KPI row, trust strip, views A, B and E, and a methodology page. Every number and label comes from the published dataset, validated at build, and a mismatch fails the build. The only other build inputs are the dataset's schemas and the methodology text. Acceptance is a local build with screenshots. Nothing is deployed in this phase.

**Rule:** cut views before cutting quality. If time runs short, drop E, then A's time series, and B's weekly series only as a last resort, since it's the page's one view of change. Never cut the trust strip, the states, the methodology page or the known limits. A dropped view leaves the page; it doesn't stay as an empty card.

## Requirements trace

| Need | Source | Unit |
|---|---|---|
| Static site reading a published dataset, no database calls from visitors | R9 | 3.1a, 3.1c |
| Schema validation at build, failing on a mismatch | Architecture, Published dataset | 3.1c |
| Last good data stays up, marked stale, if a check fails | R8, Architecture, Data flow | 3.1c, 3.2 (needs a rebuild after a failed run; see [Risks](#risks)) |
| A `--allow-partial` preview can never look like the real site | Unit 2.8 | 3.1c |
| Verdict block, KPI row, trust strip | Design system, PRD section 6 | 3.2 |
| Views A, B and E | PRD section 6 | 3.3a, 3.3b, 3.3c |
| Takeaway, source, as-of time and definition link on every chart | R10 | 3.1b (enforced), 3.3a to 3.3c |
| Mobile and design system | R11 | 3.1b, 3.6 |
| Independence line and "not financial advice" always visible | R13, Design system | 3.1b |
| Methodology and source legend | R14, PRD section 9 | 3.4 |
| Velocity's two denominators, known limits | PRD section 7, build log | 3.4, 3.3b |
| Fact, estimate and opinion kept apart; no name without a source | PRD section 9 | 3.1b, 3.1c, 3.4 |
| README for outside readers | R14 | 3.5 |

**Not in this phase:** views C, D and F, the weekly note, CSV downloads (R12, R15), hosted schedules and any deployment.

## What was checked while planning

A throwaway project outside the repo, on 2026-11-04, tested the choices below. No repo file changed.

| Question | Result |
|---|---|
| Does CI have Node and pnpm? | The runner image manifest for `ubuntu-24.04` (20261026.354.1) lists Node 22.23.4 and npm 10.9.9, and no pnpm. CI uses `ubuntu-latest`, so this is the expected image, not proof. The workflow installs neither |
| Does `npx --yes pnpm@12.16.1` work without a global pnpm? | Yes, on macOS with Node 22.23.4 and 24.10.0 |
| Does a bare Corepack `pnpm` work? | **No.** Corepack 0.34 from Homebrew looks for `bin/pnpm.cjs`, which pnpm 12 doesn't ship, and crashes |
| Does Next 16.4.5 static export work with Tailwind 4, Recharts 3 and Vitest 5? | Yes, with a build of about 9 seconds on the small test app. One plain `.ts` Vitest test only, so component tests are unproven until 3.1a |
| Latest TypeScript and ESLint? | TypeScript 7.0.2 and ESLint 10.14.0 both leave unmet peers in `eslint-config-next` and `typescript-eslint`. **TypeScript 6.0.3 and ESLint 9.39.5 have no peer issues** |
| Does a thrown error while prerendering fail the build? | Yes, exit 1 from `next build` |
| Does Recharts render to static HTML? | No. It leaves an empty responsive wrapper, so every chart's text summary and table must be server-rendered |
| Do `.gitignore` rules bite? | `data/`, `out/`, `dist/`, `logs/` and `target/` match at any depth. `web/lib/data/` would be silently ignored, so nothing is named that. `web/lib/dataset/` and `web/fixtures/dataset/` are fine |
| Can Playwright capture pages? | The CLI ran but needs its own browser download, which is an explicit local step |

**Not verified:** any of this on Linux, because the Docker daemon wasn't running here. Corepack on the runner wasn't checked either, and nothing relies on it. Unit 3.1a's own PR is the first real proof, and it can't merge unless "Build and test" shows the web steps running.

## Key decisions

- **pnpm runs through `npx`, never bare or through Corepack.** It needs only what CI already has, and it avoids the Corepack failure above. The version has one home, `packageManager` in `web/package.json`, and the Makefile reads it. npm would drop this indirection and is a cheap switch later. pnpm stays because the project's setup already assumes it.
- **`make check` includes real site builds.** CI calls only `make check`, so a static export that breaks would otherwise pass CI. It builds and verifies both committed sample datasets, because CI has no `data/`.
- **The site reads schemas straight from `pipeline/ousd/schemas/`.** There is no copy to drift. TypeScript types are generated from those files and committed, and a test fails if they drift.
- **Stale comes from three places, and each can only make the state worse.** `manifest.stale` is set when a real publish refuses. The build compares the dataset's times with the clock. A client component compares them with the reader's clock, because a static page that nobody rebuilds would otherwise never go stale.
- **Sample and preview can never read as real.** Both are derived from the data and have no off switch, and release mode refuses both. A live trust strip is never rendered on sample numbers, so live appearance is proved by component tests and by real data in 3.6, not by screenshots of a disguised sample.
- **The verdict block gets a short headline.** Unit 2.8's verdict sentence is long enough to fill the first screen at `--text-display` (about 8 lines on desktop). The site maps `verdict.state` to a short display sentence and shows `verdict.text` verbatim as the design system's one supporting line. The maintainer reviews both before 3.2 merges.
- **View A shows active as a separate measure.** The PRD asks how much is "placed, distributed, circulating and active", but volume and wallets aren't slices of a balance. The stack is issuer, placed, venues and free-floating, with clean volume and active wallets beside it.
- **View E says what leads, not what a chain is "for".** `leading_for` covers supply, issuance, everyday, DEX flow and lending flow. There's no trading measure, because we ingest no Swap events, so the site never says "trading" or "settlement" as a finding.
- **All-chain figures use each chain's newest day, the same basis as the verdict.** Otherwise the verdict and the KPI below it could disagree. The as-of shows the range when days differ. Time series sum only days every included chain has. Wallet counts are never summed across chains, because the same address on three EVM chains would count three times.
- **Chart numbers are the only floats.** Amounts stay strings and `BigInt` for all display. One function converts to `Number`, for chart geometry alone.
- **The methodology page renders `docs/methodology.md`, with the legend, labels and data-dependent limits taken from the dataset.** The doc carries the same legend and limits for GitHub readers, and tests keep them equal.
- **The site shows no wallet addresses except the four token contracts.** The dataset strips addresses from `labels.json` on purpose, to keep doxxing risk low. A named label links to a source that shows its address. Unnamed clusters are explained by their written rule, and their addresses are in `labels/labels.csv` in the repo. Until the repo is public, a reader can't check those, and the page says so.
- **Fonts are self-hosted through `@fontsource-variable`,** so the build and visitors make no Google request. There's no analytics.
- **Screenshot evidence lives on `evidence/*` branches,** never in a PR's own diff. See [Evidence](#evidence-for-web-prs).

Each one is listed with its alternatives and cost of change in the PR that adds this plan.

## Assumptions that may move

Checked against the merged `pipeline/ousd/schemas/` and `pipeline/ousd/publish.py` by unit 3.1c, on 2026-11-04. **The schema files win over this plan and over `docs/plans/2026-11-03-001-insight-models-plan.md`.**

Held as written:

- JSON Schema draft 2020-12. The loader imports `ajv/dist/2020`. One schema per JSON file: `manifest`, `summary`, `journey`, `activity`, `chain_roles`, `reconciliation`, `labels`. `journey.csv`, `activity.csv` and `chain_roles.csv` are hash-checked, not schema-checked. These ten files are the expected set: `manifest.files` lists the other nine.
- `data/published/latest` holds real output. Previews go to a separate `preview-not-for-release` folder with its own `latest-preview` pointer, so the default path can't land on one.
- Every JSON file has `preview`. `dataset_version` starts `preview-` for a preview.
- `manifest` adds `stale`, `stale_since`, `stale_reason`, `reconciliation`, `warnings`, `coverage.last_transfer_at`, `coverage.chains_without_issuer_row` and `definitions.velocity`. Check status is `passed` or `skipped` only, so a failed check can't be in a published manifest.
- The seven check names: `chain_supply`, `cross_chain_supply`, `sampled_balances`, `dbt_tests`, `volume_waterfall`, `reconciliation_gate`, `freshness`.
- `summary` has `notice`, `verdict`, `known_limits` and `kpis`. `verdict` has `state`, `scope`, `as_of`, `text`, `facts`, `estimates` and `opinions`. States are `mostly_placed`, `moving`, `mixed` and `no_clear_statement`. So 3.2's sentences stand.
- `labels` has rows without addresses (`chain`, `entity`, `category`, `source_type`, `source_url`, `confidence`, `date_checked`), plus `source_legend` parsed from `labels/README.md`, and `issuer_coverage`. The legend's shape stands, so 3.4 stands on that.
- `reconciliation` has `latest_run`, and rows with `in_latest_run`. `journey` has `issuer_labeled`.
- Row fields otherwise follow the marts, with `day_utc` renamed `day`. Chain roles keep `as_of_day`.

Moved:

- **A duplicated check can't reach the state step.** The schema gives each of the seven positions its own `const` name, in a fixed order, so a duplicate fails the load in every build. It was listed under "accepted by the schema". 3.1c tests it as a load failure, and still checks each name once in release grade.
- **`in_latest_run` isn't null on chain rows.** Publish sets it on every row, comparing each row's `run_id` with the latest run. The schema still allows null. Release grade keeps the plan's rule: chain rows by `run_id`, Bridge by `in_latest_run`.
- **`labels.data` holds named rows only, and `source_type` has no `derived_rule` there.** Unnamed clusters arrive only as `unnamed_clusters` (`rule_reference`, one `rule`, and `counts` by chain and category). For 3.4: "`derived_rule` rows" means those counts, the rule text comes from that one field, and a non-`https` source can't reach the page, because the schema requires `https://` with no query or fragment. `labels` also has `chains_without_issuer_row`, a copy of the manifest's.
- **`journey` has no `circulating_supply`.** It's in `activity` and `kpis`, as total minus issuer inventory minus placed. For 3.3a: take the step line's circulating series from `activity`, whose days run from Day 0, so limit it to `journey_first_day`.
- **`issuer_labeled` is on `kpis` too,** and in `issuer_coverage`, where it's null for a chain with no journey rows. A chain can be `issuer_labeled` true through route wallets alone and still have no `issuer` row.
- **`activity`'s KPI columns can be null on a row,** on a day that ends with no supply. Its volume columns never are.
- **`summary.notice` is the independence line, a `const`.** `manifest.notice` is the preview notice, and is null on real data.
- **`manifest.stale` can't be true on a preview.** The schema forbids it, so a preview only goes stale by the clock.
- **`verdict.text` starts "Local preview, not a finding." on a preview, or whenever a check is skipped,** and `facts` is empty there, with the figures under `estimates`. In `no_clear_statement` all three lists are empty, in any dataset. For 3.2: the partial sample shows this, and any empty group hides, not only `opinions`.
- **The legend names a real entity.** `reading_a_label` is copied from `labels/README.md` and mentions the 0x Settler labels, so even the samples carry that name. For 3.4: wrap the rendered legend in an element with `data-source-legend`, which `verify-output` allows alongside `data-labels-table`, or the methodology check will fail on it. Everything else a sample names is invented.

No verdict state, limit id or legend field moved, so 3.2 and 3.4 start as planned. No other unit reads a raw field name, because 3.1c's typed loader sits in between.

**A gap in the schema:** the brainstorm asks for Bridge's small-ticket issuance as its own line beside the waterfall, and dataset v1 has no field for it. Because the verdict says supply sits still, leaving this out silently would be one-sided. So view B and the methodology page both state, as a dated fact from the brainstorm, that issuer flows exclude this activity, that it was 4.07M in 2,441 transfers to 237 recipients in the week of October 26, against 3.13M of Tempo everyday volume, and that its cause is unproven. Showing it live needs a mart column and a schema change, so that's deferred.

## How it fits together

Directional, not a specification.

```
pipeline/ousd/schemas/*.schema.json ---+
data/published/latest/  (or sample) ---+--> web/lib/dataset  (server only, at build)
docs/methodology.md -------------------+      files, hashes, schema, sums, state
                                               |
                                               v
                       typed dataset + state --> server components --> static output
                                                       |
                                     small series --> client charts, freshness check
```

### Dataset states

Precedence: sample, then preview, then stale, then fresh.

| Dataset | Normal build | `make web-release` | What the reader sees |
|---|---|---|---|
| Unknown or missing file, schema, file hash, row count or sum mismatch, unknown `schema_version`, or files that disagree on `preview` | **Fails** | **Fails** | Nothing new. Earlier output stays |
| Sample: a `FIXTURE` file beside the manifest, a path under `web/`, or `git_commit` of all zeros | Builds | **Refuses** | Non-real frame, "Sample data. Nothing here is real." |
| Preview: `preview` true, a `preview-` version, `coverage.complete` false, a required chain missing, or missing reconciliation evidence (see Release grade in 3.1c) | Builds | **Refuses** | Non-real frame, "Local preview. Not the published site." then "{n} of 4 chains, {m} checks not passed.", or "Reconciliation evidence is missing." when those counts are clean |
| Real, `manifest.stale` true | Builds | Builds | Same data. "A newer run did not pass its checks. Data from {time}." Trust strip changes |
| Real, older than the limit at build or in the browser | Builds | Builds | Same data. "Data from {time}. Nothing newer has reached this page, so it may be out of date." Trust strip changes |
| Real, fresh | Builds | Builds | "Supply reconciled on all 4 chains as of {time} UTC" |
| One value null | Builds | Builds | "Not enough data yet", never a zero |

**Fresh** means `generated_at`, `reconciliation.finished_at` and every chain's `last_transfer_at` are all within 36 hours, the limit in architecture check 6. Checking only `generated_at` would let two 36-hour windows stack, showing a nearly three-day-old reconciliation as current. A `generated_at` in the future counts as stale.

**The non-real frame**, identical for sample and preview apart from the words, on every page and not dismissible:
- a full-width `--surface-inverse` banner under the header, which scrolls away rather than sticking
- a hatched edge on the page and on every chart card, visible at 320
- a "Sample" or "Preview" word beside each card's as-of time and in the KPI row, so a crop of one card still reads as not real
- `[Sample]` or `[Preview]` in the page title, and `noindex`
- "Sample, not a finding" or "Preview, not a finding" in place of "Our reading" on the verdict
- a trust strip that says "Not reconciled"

`partial` sits under `web/`, so it shows sample wording and its chain and check counts. A real `make preview` output shows preview wording. Stale notes still appear under either.

## Page structure

Main page, in order: header, banner if any, question line, verdict block, KPI row, trust strip, view A, view B, view E, footer. There's no in-page navigation, and there are no interactive controls in this version. Anchors: `#supply-journey`, `#real-activity`, `#chain-roles-view`.

| Part | Cards, in order | Heading |
|---|---|---|
| Verdict | Display sentence | `h1` |
| View A | Stacked bars with the side measures as a table | `h2` takeaway |
| | Step line, all chains only | `h3` takeaway |
| View B | Waterfall | `h2` takeaway |
| | Weekly everyday bars | `h3` takeaway |
| | Velocity and active wallets, a table card | `h3` takeaway |
| View E | Chain table, a table card | `h2` takeaway |

Every card has its takeaway, chip, source, as-of time and definition link. A table card has no chart and no second table.

**Mixed cards:** a card takes its weakest chip, in the order Fact, Inferred, Estimate, and each row or label carries its own where they differ.

## Output structure

```
Makefile                          web targets
docs/methodology.md
tests/test_site_fixtures.py
web/
  package.json  pnpm-lock.yaml  pnpm-workspace.yaml  next.config.ts  tsconfig.json
  eslint.config.mjs  .prettierrc.json  .prettierignore  .gitignore
  postcss.config.mjs  vitest.config.ts
  app/         layout.tsx  page.tsx  methodology/page.tsx  globals.css  tokens.css
  components/  site-header  site-footer  mark  status-chip  hairline-table  accordion
               chart-card  chart-theme  dataset-banner  freshness
               verdict-block  kpi-row  trust-strip  methodology-tables
               views/journey  views/journey-charts  views/activity  views/activity-charts
               views/chain-roles
  lib/         dataset/  format.ts  definitions.ts  aggregate.ts  site.ts  methodology.ts
               verdict.ts  takeaways/journey.ts  takeaways/activity.ts  takeaways/chain-roles.ts
  fixtures/dataset/complete/  fixtures/dataset/partial/
  scripts/     verify-output.mjs  shots.mjs  fixture-hashes.mjs  blocked-names.json
  tests/
```

## Implementation units

### Order and overlap

```
3.1a tooling --> 3.1b tokens and shell --> 3.1c loader and page frame (needs 2.8 merged)
                                                   |
             +-------------+-----------+-----------+-----------+
             v             v           v           v           v
            3.2          3.3a        3.3b        3.3c         3.4
             +-------------+-----------+-----------+-----------+
                                       v
                                      3.6       3.5 starts any time after 3.1a, merges after 3.4
```

| Unit | Runs with | Shared files |
|---|---|---|
| 3.1a | Concurrent 2.7 and 2.8 | `Makefile` (they add `run`, `dagster-dev`, `publish` and `preview`), so rebase on them |
| 3.1b | Nothing, runs alone | `web/app/layout.tsx` and `web/app/globals.css`, after 3.1a |
| 3.1c | Nothing, runs alone | `web/app/layout.tsx`, `web/app/page.tsx` and `Makefile`, after 3.1b |
| 3.2, 3.3a, 3.3b, 3.3c, 3.4 | Each other | **None.** 3.1c creates every stub, so each unit replaces only its own files and `web/app/page.tsx` doesn't change again |
| 3.5 | Anything | None. It touches no `web/**` |
| 3.6 | Nothing, runs last | Fixes anywhere under `web/` |

Two soft rules keep the fan-out clean. New dependencies don't get added in the fan-out, because 3.1a installs everything the plan needs and a second lockfile edit conflicts. A token missing from `web/app/tokens.css` is added there and in `docs/design-system.md` in the same change, which is rare and a small rebase.

**Fixed definition anchors,** so parallel units agree: `verdict`, `minted-burned`, `issuer-inventory`, `venue-supply`, `placed-supply`, `free-floating`, `circulating-supply`, `headline-volume`, `clean-volume`, `everyday-large`, `venue-flow`, `tempo-fee`, `velocity`, `active-wallets`, `concentration`, `implied-reserve-income`, `chain-roles`, `reconciliation`, `known-limits`, `source-legend`, `named-labels`, `unnamed-clusters`, `fact-estimate-opinion`. They live in `web/lib/definitions.ts`.

---

- [ ] **Unit 3.1a: Scaffold and tooling**

**Goal:** a static Next.js app that `make check` lints, type-checks, tests and builds, in CI and locally.

**Dependencies:** none. Can start before 2.8 merges.

**Files**
- Create: `web/package.json`, `web/pnpm-lock.yaml`, `web/pnpm-workspace.yaml`, `web/next.config.ts`, `web/tsconfig.json`, `web/eslint.config.mjs`, `web/.prettierrc.json`, `web/.prettierignore`, `web/.gitignore`, `web/postcss.config.mjs`, `web/vitest.config.ts`, `web/app/layout.tsx`, `web/app/page.tsx`, `web/app/globals.css`, `web/scripts/shots.mjs`
- Test: `web/tests/smoke.test.tsx`, `tests/test_makefile_web.py`
- Modify: `Makefile`, `docs/architecture.md` (below)

**Approach**

Pinned versions, as tested:

| Package | Version |
|---|---|
| `next`, `eslint-config-next` | 16.4.5 |
| `react`, `react-dom` | 19.3.1 |
| `recharts` | 3.10.1 |
| `tailwindcss`, `@tailwindcss/postcss` | 4.3.4 |
| `typescript` | 6.0.3, not 7 |
| `eslint` | 9.39.5, not 10 |
| `prettier` | 3.9.10 |
| `vitest` | 5.1.0 |
| `pnpm` | 12.16.1 |

Also install `ajv`, `ajv-formats`, `marked`, `@fontsource-variable/inter` and `@fontsource-variable/newsreader`. Dev tools: `@types/node`, `@types/react`, `json-schema-to-typescript`, `@testing-library/react`, a DOM for tests, any JSX or `server-only` test tooling, `axe-core`, `playwright` and `@axe-core/playwright`. Packages not in the table use their newest version that passes the rules below, pinned exactly.

- **Install safety:** every install uses `--frozen-lockfile` except when deliberately changing dependencies. `web/pnpm-workspace.yaml` sets an `onlyBuiltDependencies` allowlist, empty unless a package proves it needs one, because `.env` sits one directory up from installs. The Playwright browser download stays an explicit local step.
- Pnpm 12 wrote `minimumReleaseAgeExclude` entries for the newest Next packages during the test. Prefer the newest versions that clear its default age, so the file needs no exclusions.
- jsdom 30 needs Node 24.15 or later, and the local Node is 24.10. Use an older jsdom or happy-dom.
- `web/package.json` sets `engines.node` to `^22.12 || ^24`, which is Vitest 5's range without Node 26.
- `next.config.ts`: `output: "export"`, `trailingSlash: true` so the output serves from any static server, and `images.unoptimized: true`.
- ESLint runs directly, because Next 16 has no `next lint`. Generate `next-env.d.ts` with `next typegen` before `tsc`, or commit it, whichever proves simpler.
- Prettier covers `web/` only, so it never touches `docs/`.
- `web/.gitignore` covers `.shots/`, `.build/` and `.release/`.

**Makefile, in this unit**

| Target | Before `web/package.json` exists | After |
|---|---|---|
| `make web-install` | Fails: no site | Installs through `npx pnpm` at the version in `packageManager`, with a frozen lockfile |
| `make check` | Python checks, unchanged | Python checks, then install, Prettier, ESLint, `tsc`, Vitest and a build |
| `make lint`, `types`, `test` | Python, unchanged | Python, plus the matching web step |
| `make build` | `uv build --wheel`, unchanged | Also builds the site |
| `make web-shots` | Fails: no site | Local only. Never called by `make check` |

3.1c adds the dataset, `verify-output` and `make web-release` to this table.

- **If Node or npm is missing, or the Node version is out of range, the web step fails with a message that says what to install.** It never skips, because a check that passes silently is worse than a red one. So if the runner ever lacks Node, 3.1a's PR stays red and unmerged and no other PR is affected until the owner acts (see [Owner actions](#owner-actions)).
- Web steps never load `.env`, and web code never references an RPC variable. Next reads env files only from `web/`, where none exists.

**Architecture changes, in this unit**
- Commands: the section says `make build` and `make test` are commands CI calls, but `ci.yml` runs only `make check`, so the text should say so. "No network" becomes "no chain access", since a clean install reaches package registries, as `uv` already does.
- Site: reads the published dataset, plus its schemas and `docs/methodology.md` at build.
- Add pnpm to the stack table.

**Test scenarios**
- Happy path: a clean checkout runs `make check` to exit 0, and "Build and test" on this PR shows the web steps in its log, with their time reported in the PR.
- Happy path: with `web/package.json` absent, the Makefile runs no web command (Python test using `make -n` on an isolated copy, without recursing into `make check`).
- Error path: with `node` off `PATH` and `web/package.json` present, `make check` exits non-zero and prints the install message.
- Edge case: a Prettier violation, an ESLint error, a type error and a failing Vitest test each make `make check` exit non-zero (each tried by hand once, reported in the PR).
- Smoke: `web/tests/smoke.test.tsx` renders one component in the chosen DOM, and calling `fetch` in a test throws, so tests can't use the network.

**Verification:** "Build and test" is green with the web steps visible. The PR's `## Evidence` has a screenshot of the placeholder page and a link to that CI run.

---

- [ ] **Unit 3.1b: Tokens, shell and shared components**

**Goal:** every token and shared component in the design system, including a chart card that can't be used without its required parts.

**Dependencies:** 3.1a.

**Files**
- Create: `web/app/tokens.css`, `web/components/site-header.tsx`, `web/components/site-footer.tsx`, `web/components/mark.tsx`, `web/components/status-chip.tsx`, `web/components/hairline-table.tsx`, `web/components/accordion.tsx`, `web/components/chart-card.tsx`, `web/components/chart-theme.ts`, `web/lib/site.ts`
- Test: `web/tests/tokens.test.ts`, `web/tests/shell.test.tsx`, `web/tests/chart-card.test.tsx`
- Modify: `web/app/layout.tsx`, `web/app/globals.css`, `docs/design-system.md`

**Approach**
- **Independence line:** exactly "Independent. Not affiliated with Open Standard or Bridge." in the header and footer of every page. The header is sticky at every width, so the line stays on screen. At narrow widths it wraps to a second header row and is never hidden or truncated. `--header-height` stays 60px on desktop and becomes a minimum on phones, with a budget of 88px at 390, and `scroll-padding-top` so anchors aren't covered. The line uses body colour, not a subdued one.
- **Footer:** independence line, not financial advice, not an attestation with a link to Bridge's reports, GitHub link. The repo URL is one constant in `web/lib/site.ts`, and the link hides while it's empty.
- **Our mark:** a simple SVG of our own. No Open Standard logo, wordmark, globe, or the Season font.
- **Chart card:** takeaway, chip, source, as-of time, definition anchor, text summary and table are all required props, so a chart missing one doesn't compile. The summary and table are server-rendered, since Recharts isn't, and the table sits in an accordion. Dotted horizontal gridlines only, compact ticks, no animation, dates labelled UTC. Tooltips add detail and hold nothing essential.
- **Chart area:** a fixed reserved height per breakpoint, with a `--color-secondary` skeleton until the chart mounts, so nothing shifts. With JavaScript off, it says "This chart needs JavaScript. The table below has the same data." The graphic is `aria-hidden` and out of the tab order, because the summary and table carry the content, so Recharts' keyboard layer is off.
- **Hairline table:** below 768, rows stack as label and value pairs, and long exact amounts wrap with `overflow-wrap: anywhere`. This one behaviour covers every table on the site, so none needs horizontal scroll.
- **Chips:** see [Fact, estimate and opinion](#fact-estimate-and-opinion).
- **Contrast, measured on `--color-off-white`:** maroon 14.2:1, ramp step 2 5.9:1, positive 5.3:1, negative 5.5:1. Step 3 is 2.9:1 and step 4 is 1.6:1, so they fail both text and the 3:1 limit for graphics. Those two get a maroon hairline outline and direct labels, and are never used for text. `--text-meta` uses maroon or step 2.

**Design system changes, in this unit**
1. **Add named widths.** It names 1440px and 1056px and no phone width. Add 320 (the WCAG reflow width), 390, 768, 1056 and 1440, and say that two-column charts begin at 1056.
2. **Add an Opinion chip,** shown as "Our reading". The current chip set has no way to mark an opinion, and the PRD requires it.
3. **Add a non-real state** for sample and preview. Split stale from check failed by what's known: "A newer run did not pass its checks" when the manifest says so, and "Nothing newer has reached this page" when only the clock does.
4. **Trust strip wording:** "Supply reconciled on all 4 chains as of {time} UTC", dated and naming what was reconciled, replacing "All 4 chains reconciled", which implies inferred numbers are verified too and reads as current at any age.
5. **Verdict block:** add a question line above the display sentence, and let `opinions` show below the supporting line.
6. **Record** the outline rule for ramp steps 3 and 4, the header's narrow-width behaviour and the stacked-table rule.

**Test scenarios**
- Happy path: every token in the design system tables exists in `tokens.css` with the same value.
- Happy path: body, meta and banner text tokens reach 4.5:1 on their surfaces, computed in the test.
- Error path: no hex colour appears in `web/components/**` or `web/lib/**` (a scan), and a planted one fails it.
- Happy path: header and footer both render the exact independence line, and the footer also says not financial advice and not an attestation.
- Edge case: with the repo URL empty, the GitHub link is absent rather than dead.
- Happy path: chart card renders the takeaway as a heading, then source, as-of time, a definition link and a table. The graphic is hidden from assistive tech. No axe violations (jsdom, without colour contrast).
- Edge case: a hairline table with a 20-digit amount renders its stacked form with the full value.
- Happy path: no image, font or SVG asset under `web/` other than our mark and the Fontsource packages.

**Verification:** `## Evidence` has the shell at 390 and 1440, and a chart card with sample data.

---

- [ ] **Unit 3.1c: Dataset loader, sample data, states and page frame**

**Goal:** the one way into the data, plus the page frame that every later unit fills in.

**Dependencies:** 3.1b. **Unit 2.8 merged**, because its schema files are the source of truth. Check them first and update [Assumptions that may move](#assumptions-that-may-move).

**Files**
- Create: `web/lib/dataset/load.ts`, `web/lib/dataset/state.ts`, `web/lib/dataset/types.generated.ts`, `web/lib/dataset/index.ts`, `web/lib/format.ts`, `web/lib/aggregate.ts`, `web/lib/definitions.ts`, `web/components/dataset-banner.tsx`, `web/components/freshness.tsx`, `web/components/verdict-block.tsx`, `web/components/kpi-row.tsx`, `web/components/trust-strip.tsx`, `web/components/views/journey.tsx`, `web/components/views/activity.tsx`, `web/components/views/chain-roles.tsx`, `web/app/methodology/page.tsx`, `web/fixtures/dataset/complete/*`, `web/fixtures/dataset/partial/*`, `web/scripts/verify-output.mjs`, `web/scripts/fixture-hashes.mjs`, `web/scripts/blocked-names.json`
- Test: `web/tests/load.test.ts`, `web/tests/state.test.ts`, `web/tests/format.test.ts`, `web/tests/aggregate.test.ts`, `web/tests/freshness.test.tsx`, `web/tests/frame.test.tsx`, `web/tests/verify-output.test.ts`, `tests/test_site_fixtures.py`
- Modify: `web/app/layout.tsx`, `web/app/page.tsx`, `Makefile`

The components under `components/` that later units own start as stubs that render "Not enough data yet" from typed props.

**Approach**
- **Where data comes from:** `OUSD_DATASET_DIR`, defaulting to `../data/published/latest`, then to the sample, with the page saying which. The loader is server-only, and client components receive only the props they draw.
- **Load order, stopping at the first failure:** read the manifest; require `schema_version` 1; require `manifest.files` to equal the expected file set exactly, so no name is read from the manifest and no file escapes checking; check each file's SHA-256 and row count; validate each JSON file with Ajv using `allErrors`; require every file to agree on `preview`; check that journey parts add up to total supply and waterfall parts add up to headline, per chain and day, with `BigInt`; derive the state.
- **Errors** name the dataset-relative file, field and rule. They never dump row contents or print an absolute path.
- **Pipeline strings that aren't reader copy are never rendered or passed to client components:** check `detail` and `stale_reason`. The site shows its own label per check. `verdict.text`, its three lists, `known_limits` and the legend are written for readers, and render as given.
- **Release grade** comes from the dataset alone and needs all of:
  - not sample, and `preview` false
  - `coverage.complete` true, with all four chains present in `chains_included` and with rows in journey, activity and chain roles
  - `verdict.scope` covers the four chains
  - exactly the seven checks, each once, each `passed`
  - `latest_run` and `manifest.reconciliation` both a `full` run with status `pass`
  - exactly one `passed` chain row per chain, each with `run_id` equal to `latest_run.run_id`, and one `passed` Bridge row with `in_latest_run` true. The mart sets `in_latest_run` only on Bridge rows, so it's null on chain rows by design
  - `manifest.definitions` equal the documented defaults, one constant in `web/lib/definitions.ts`

  Anything else is preview. `make web-release` doesn't change how data is classified. It only refuses anything that isn't release grade.
- **Warnings:** `make web-release` prints every `manifest.warnings` entry and refuses until `OUSD_ACK_WARNINGS` equals that `dataset_version`, because warnings exist for human review and nothing else stops a dataset that reconciles but looks wrong. A normal build only logs them.
- **Sample data** is synthetic, with round numbers, a `git_commit` of all zeros and a `FIXTURE` file. It's never edited from real output. `complete` has four chains, and one chain where `velocity_bps` is above `headline_velocity_bps` so that explanation gets exercised. It also has a null ratio, a zero-activity day, chains at different days, a chain with `issuer_labeled` false, and an amount above 2^53. `partial` is Tempo and Ethereum with `skipped` checks, the shape `make preview` writes. `fixture-hashes.mjs` refreshes the manifest hashes.
- **`format.ts`:** amounts as compact (`$605.5M`) and exact, using `BigInt` with half-up rounding. Basis points as percent. Null as "Not enough data yet". Dates in UTC, labelled. 1 OUSD displays as $1, and the methodology page says we don't track price. `toChartNumber` is the one place an amount becomes a float.
- **`aggregate.ts`:** all-chain amounts at each chain's newest day, the verdict's basis, with the range named in the as-of. Ratios use the marts' integer floor formula. Placed share comes from summed amounts, as the verdict's does. All-chain velocity is null if any chain's velocity is null, because its window is short. Time series sum only days every included chain has. All-chain flows run from Day 0, one constant, to each chain's newest day. No function sums wallet counts.
- **`Freshness`:** one client component sets `data-freshness` on the page root after comparing clocks, and CSS switches between server-rendered fresh and stale text in the same place, so nothing shifts. The as-of line is a polite status region. It can move fresh to stale and never back. Fresh text is dated, so with JavaScript off, or in an archive, it stays true at any age.
- **`verify-output.mjs`** runs on every build, including `make build` and `make web-release`. It derives the expected state from the manifest, not from an argument:
  - Every page has the independence line and "not financial advice".
  - Sample and preview output has its frame, and no "Supply reconciled on all 4 chains".
  - No page has a full `0x` plus 40 hex address or a 32 to 44 character base58 string in visible text, except the four token contracts on the methodology page.
  - Neither `detail` nor `stale_reason` strings appear anywhere in the output, including serialized props, and no `_RPC_URL` name does either.
  - The main page has no name from `blocked-names.json`: every `entity` in `labels/labels.csv` and every name in PRD section 4, minus the four chains, Bridge and Open Standard, matched as case-sensitive whole words, so `Coinbase` and `Base` stay distinct. A test keeps that list complete against the labels file. Methodology may have these names only in the labels table or next to a source link.
  - No `on*=` attribute, no link that isn't `https`, `mailto` or same-site, `rel="noopener noreferrer"` on outbound links, and no request host other than our own.
  - Each chart card has its source, as-of and definition link.
- **Makefile, in this unit:**
  - `make check` builds and verifies both `complete` and `partial` under `web/.build/`.
  - `make build` builds and verifies from the default path.
  - `make web-release` builds to a temporary folder, verifies, then atomically points `web/.release/latest` at the result. Nothing else writes there, so it's the last good version and a sample build can never overwrite it.

**Test scenarios**
- Happy path: `complete` and `partial` load, and every file validates against the real files in `pipeline/ousd/schemas/`.
- Happy path (pytest): each sample's `known_limits` matches `known_limits()` for its coverage, its legend matches `labels/README.md`, and each file passes `jsonschema`.
- Error path, each failing the load with the file and field named and no absolute path: amount as a float; amount as a number above 2^53; an extra field; a missing field; `schema_version` 2; an unknown `verdict.state`; a missing file; an extra entry or a `../` name in `manifest.files`; a hash mismatch; a row count mismatch; files disagreeing on `preview`; a journey sum off by one base unit; a waterfall sum off by one base unit.
- Integration: a mismatched dataset makes the build target exit non-zero, and `web/.release/latest` is unchanged.
- Integration: a failing `verify-output` also leaves `web/.release/latest` unchanged.
- Happy path: regenerating types from the schemas equals the committed `types.generated.ts`, and a changed schema fails this test.
- State table: each row of [Dataset states](#dataset-states).
- Release grade, rejected by the schema when `preview` is false, so a load failure in every build: three chains with `complete` true; a check absent; a check `skipped`.
- Release grade, accepted by the schema, so preview and a refusal naming why: a check duplicated; an empty `reconciliation.json`; a missing Solana row; a missing Bridge row; a chain row from another run; a Bridge row not `in_latest_run`; `latest_run` partial; rows missing for one chain in journey; `verdict.scope` short of four; changed `definitions`.
- Sample: `complete` copied outside `web/` with its `FIXTURE` file removed is still sample, through `git_commit`.
- Warnings: a dataset with one refuses release without the matching `OUSD_ACK_WARNINGS`, and builds with it. One without warnings needs nothing.
- Freshness, with a fake clock: 35h59m is fresh and 36h01m is stale on each of the three times separately. A recent `generated_at` with a 40-hour-old reconciliation is stale. `manifest.stale` true is stale whatever the clock says. A dataset stale at build stays stale. A future `generated_at` is stale.
- Format: 2^53 + 1 base units prints exactly; rounding at .05 boundaries; zero prints as `$0`; null prints the unknown text and never `0`; negative amounts carry a sign.
- Aggregate: chains at different days give a named range; a time series drops days a chain lacks; all-chain velocity equals the integer formula on a worked example; one chain's null velocity gives a null all-chain velocity; a chain at zero supply still gives an all-chain placed share; a zero denominator gives null.
- `verify-output`: each rule fails on a planted bad page and passes on a good one, including a labelled entity's name, an address that isn't a token contract, and a `detail` string in a serialized prop.
- Frame: the page renders in the order in [Page structure](#page-structure) with every stub, and the methodology page exists.

**Verification:** `## Evidence` has the `complete` and `partial` sample pages at 390 and 1440, and one card cropped alone. It's obvious at a glance that none is real.

---

- [ ] **Unit 3.2: Verdict block, KPI row and trust strip**

**Goal:** the first screen answers the question, and the trust strip visibly changes state.

**Dependencies:** 3.1c. The maintainer's review of the verdict wording before this merges.

**Files**
- Create: `web/lib/verdict.ts`
- Modify: `web/components/verdict-block.tsx`, `web/components/kpi-row.tsx`, `web/components/trust-strip.tsx`
- Test: `web/tests/verdict.test.tsx`, `web/tests/kpi-row.test.tsx`, `web/tests/trust-strip.test.tsx`

**Approach**
- **Question line,** above the sentence, because "sitting still" means nothing without it: "Open USD (OUSD) pays partners to distribute it. Is that turning into money that moves?"
- **Display sentence** from `verdict.state`, carrying an "Our reading" chip and linking `#verdict`. Each states only what its conditions establish, so a change in the data can't make it false. Proposed wording, for the maintainer's review:

  | State | Sentence |
  |---|---|
  | `mostly_placed` | Most Open USD (OUSD) supply is sitting still. |
  | `moving` | Under half of Open USD (OUSD) supply is sitting still, and everyday transfers are at least 5% of supply a week. |
  | `mixed` | Neither mostly placed nor clearly moving: the data doesn't support a clear statement on Open USD (OUSD) yet. |
  | `no_clear_statement` | The data doesn't support a clear statement on Open USD (OUSD) yet. |

  With partial scope, each starts "On {chains}:" and otherwise reads the same.
- **Supporting line:** `verdict.text` verbatim, with an Inferred chip. At four-chain scope, 2.8 drops the share clause. At partial scope the text includes that estimated share, so the chip is Estimate.
- **Below it:** the data-as-of time, showing a range when chains differ, and an accordion that keeps `facts`, `estimates` and `opinions` apart under "From the data, by the rules on the methodology page", "Depends on an assumption" and "Our reading". The first heading avoids the word "fact", because `facts` includes rule-based figures that this plan chips as Inferred.
- **KPI row,** four numbers split by hairlines and a 2x2 grid on phones, each with a label, a one-line definition as its note, and a chip: total supply, placed share, 7-day everyday volume, everyday velocity. Everyday velocity fits the question. Clean velocity is mostly large transfers, so on its own it would argue with the headline, and view B shows all three together. Wallet counts stay out of the KPI row, because they can't be summed.
- **Trust strip:** the dated sentence and a link to `#reconciliation`. The detail accordion lists each chain's block, event total, reference total and difference, and Bridge's comparison, in exact amounts. It says reconciliation covers mints minus burns against supply at the block shown, that KPI totals are at the named day's close, and that this doesn't verify placed share or velocity.
- Each trust strip state differs by words and shape, not colour alone. Stale says "Last reconciled {time} UTC." with the matching reason from [Dataset states](#dataset-states). Fresh and stale text are both server-rendered, for `Freshness` to switch.

**Test scenarios**
- Happy path: each of the four states gives its sentence, and `verdict.text` appears unchanged.
- Edge case: `moving` or `mixed` from a mint-driven drop in placed share, just under 50% with almost no everyday volume, still reads true.
- Edge case: with partial scope, the sentence names the chains and doesn't say "all chains".
- Edge case: an empty `opinions` list hides that group, with no placeholder.
- Happy path: the placed share in the KPI row, floored to a whole percent, equals the one in `verdict.text` on the sample, including with chains at different days.
- Happy path: a null ratio shows the unknown text.
- Trust strip, one test per state: fresh, stale by clock, `manifest.stale`, preview, sample. The fresh sentence appears only in fresh.
- Happy path: the difference column prints exact base-unit amounts, including a value above 2^53.
- Happy path: the verdict links `#verdict`.

**Verification:** at 1440x900 the verdict block, KPI row and trust strip are all above the fold. At 390x844 the verdict block and as-of time are, and the KPI row starts. Evidence shows `complete` and `partial` with the sample frame, and the stale note on a sample with a fake browser clock. Preview wording and the live strip are proved by their tests here, and on real data in 3.6.

---

- [ ] **Unit 3.3a: View A, supply journey**

**Goal:** of the supply there is, how much is placed, in venues, free-floating or with the issuer.

**Dependencies:** 3.1c.

**Files**
- Create: `web/lib/takeaways/journey.ts`, `web/components/views/journey-charts.tsx`
- Modify: `web/components/views/journey.tsx`
- Test: `web/tests/takeaways-journey.test.ts`, `web/tests/journey.test.tsx`

**Approach**
- A horizontal stacked bar, all chains and one row per chain: issuer inventory, placed, DEX, lending and exchange venues, free-floating. A bracket or label marks what circulating covers. Colours are meaning colours, with direct labels. A segment too small for its label moves it to a list under the bar, and the table has every value.
- A step line of total, placed and circulating over time, all chains only, starting at `definitions.journey_first_day`. Publish already omits earlier days, and the card says why. Series use meaning colours. Per-chain values are in the table.
- Beside the bars, not as a slice: 7-day clean volume and active wallets per chain, as a table.
- Holder counts and top-10 share (`concentration`) in the data table. The share is `top10_value` over `total_supply`, per chain, and unknown at zero supply.
- Takeaway from the data, for example: "{x}% of supply on {chains} has stayed in wallets of $1M or more for at least {N} days." It states what was measured and doesn't speak to intent. A note says placed measures dollars that stayed, not why.
- A chain with `issuer_labeled` false says its issuer inventory reads as zero because no wallet there is labelled. Exchange custody without a label counts as placed. The card links `#venue-supply`.

**Test scenarios**
- Takeaway at and around the 50% boundary, with one chain, with four, and with null. It never contains "all chains" on partial scope, or a name from `blocked-names.json`.
- Happy path: the parts render with the values from the sample, and the table shows exact amounts.
- Edge case: chains at different as-of days show each day. A chain at zero supply doesn't divide by zero.
- Edge case: a chain with `issuer_labeled` false shows its note. A tiny segment moves its label.
- Edge case: an empty series renders the unknown text with no chart.
- Happy path: each card has its required parts and no axe violations.

**Verification:** Evidence at 390 and 1440. No text is smaller than `--text-meta`, and bar labels stay legible at 320.

---

- [ ] **Unit 3.3b: View B, real activity**

**Goal:** how much of the headline volume is left after each removal, and what velocity means here.

**Dependencies:** 3.1c.

**Files**
- Create: `web/lib/takeaways/activity.ts`, `web/components/views/activity-charts.tsx`
- Modify: `web/components/views/activity.tsx`
- Test: `web/tests/takeaways-activity.test.ts`, `web/tests/activity.test.tsx`

**Approach**
- **Waterfall** from headline, in the mart's order: mints, burns, fees, fee liquidity, issuer flows, same-entity, same-transaction netting, DEX flow, lending flow. It ends at clean large and clean everyday. One horizontal row per step at every width, with the label and value on the left and the bar on the right, so it reads top to bottom and a tiny bar still has a readable label. Removals are hatched as well as coloured.
- Period: Day 0 through each chain's newest day, both shown, all chains, with a per-chain table. If a chain's history starts later, the table shows it.
- **Small-ticket issuance note:** the dated fact from [A gap in the schema](#assumptions-that-may-move), under the waterfall, with its cause called unproven.
- **Weekly everyday volume** as bars. The label gives the history length from the data: "{n} days of history: a direction, not a trend", matching the shipped limit. Whether that ever changes is the maintainer's call, not a threshold.
- **Velocity and wallets, a table card:** ours, the everyday version and headline velocity, with their denominators, per chain. Active wallets at $1 and at $100. "Wallets, not people."
- **The two denominators, on the card, in plain words:** "Velocity divides clean volume by circulating supply. Headline velocity divides all transfers by total supply. Because circulating supply is smaller, velocity can be higher than headline velocity even though clean volume is smaller than headline volume. They aren't two cuts of one number." Links `#velocity`.
- **Wording that must hold:** "DEX flow", never trading volume. "Everyday" means under $1M and nothing about commerce. Large transfers are split out, not removed. Hops across transactions still count more than once.

**Test scenarios**
- Happy path: waterfall steps sum back to headline exactly on the sample, and the final bars equal clean large and clean everyday.
- Edge case: a part at 0 still appears with its label. A fee of $21 next to a $2B headline keeps a readable label.
- Takeaway: at boundaries, with zero headline, and with null. Text never claims what the transfers were for.
- Happy path: on the sample chain where velocity exceeds headline velocity, both values, their denominators and the explanation render.
- Edge case: a chain under 7 days has null velocity and shows the unknown text, not 0%.
- Edge case: the history length in the label comes from the data, not a fixed number.
- Happy path: no all-chain wallet total appears anywhere in the view, and the words "trading volume" don't either.
- Happy path: the small-ticket note renders with its date and "unproven".

**Verification:** Evidence at 390 and 1440. The waterfall reads top to bottom at phone width, and hatching shows in the screenshot.

---

- [ ] **Unit 3.3c: View E, chain roles**

**Goal:** what leads on each chain, without claiming more than the data shows.

**Dependencies:** 3.1c.

**Files**
- Create: `web/lib/takeaways/chain-roles.ts`
- Modify: `web/components/views/chain-roles.tsx`
- Test: `web/tests/takeaways-chain-roles.test.ts`, `web/tests/chain-roles.test.tsx`

**Approach**
- A hairline table card, one row per chain, with colour squares from the ramp: supply share, placed share, minted and burned in 30 days, clean everyday share, DEX flow and lending flow, as-of day. Share of supply sits beside each share of activity, so a role differs visibly from plain size. No chart, since this is the first view to cut.
- Sentences come from `leading_for`, using an exact map: `supply` "Holds the most supply", `issuance` "Most minted in 30 days", `everyday` "Most everyday clean volume in 30 days", `dex_flow` "Largest DEX flow in 30 days", `lending_flow` "Largest lending flow in 30 days". A chain with none has no sentence, so the page passes no judgment on it.
- A plain note: we don't ingest swaps, so this view can't show trading. It links `#chain-roles`.
- Each row shows its own `as_of_day`, as unit 2.6 requires.
- **Check first:** if a published dataset exists, read `chain_roles.json` before building. If `leading_for` only restates chain size, say so in the PR, because that's the case for cutting this view.

**Test scenarios**
- Happy path: each `leading_for` value gives its sentence. An unknown value fails a test rather than printing raw.
- Edge case: empty `leading_for`, a tie where two chains lead on one measure, and a null share.
- Happy path: different `as_of_day` values show per row, and the takeaway says so when they differ.
- Happy path: the words "trading" (other than the plain note) and "settlement" don't appear as findings.
- Happy path: the table uses the hairline table's stacked form at phone width (checked in markup here, and at 320 in 3.6).

**Verification:** Evidence at 390 and 1440.

---

- [ ] **Unit 3.4: Methodology page and `docs/methodology.md`**

**Goal:** a skeptical stranger can trace any number to its definition and source, and can see how we know any label.

**Dependencies:** 3.1c. Anchors are fixed above, so it runs alongside the views.

**Files**
- Create: `docs/methodology.md`, `web/lib/methodology.ts`, `web/components/methodology-tables.tsx`
- Modify: `web/app/methodology/page.tsx`
- Test: `web/tests/methodology.test.tsx`, `web/tests/methodology-tables.test.tsx`, `tests/test_site_fixtures.py` (extends what 3.1c created)

**Approach**

`docs/methodology.md` is the only prose, rendered at build with `marked`. A small renderer maps each heading to its fixed anchor and fails the build on a missing one. It also fails on raw HTML, because `marked` passes that through by default and the doc ships to every visitor.

The page has a section list at the top, collapsed on phones. An arriving anchor clears the sticky header and is visibly marked, and the browser's back button is the way back. It covers:

- **What this is and isn't:** independent, not financial advice, not an attestation, with a link to Bridge's reports. Which question it answers. Which sources it doesn't compete with, and links to them (PRD section 5). We count 1 OUSD as $1 and don't track price.
- **The ticker:** OUSD also belongs to Origin Dollar. All data is filtered by these four contract addresses, listed in full.
- **The verdict:** the four states, their thresholds (50% placed, 5% everyday), that these are judgments, why they were chosen, and what would change the headline.
- **Every definition** from PRD section 7, each at its fixed anchor. Implied reserve income is marked as later.
- **Velocity's two denominators,** with a worked example showing how velocity can exceed headline velocity.
- **Reconciliation:** the seven blocking checks in plain words, what each does and doesn't prove, and where to see the latest result.
- **Fact, estimate and opinion:** the table in [this plan](#fact-estimate-and-opinion), for readers.
- **Source legend:** rendered from `labels.json`'s `source_legend`. The doc carries the same words as `labels/README.md`.
- **Named labels:** generated from `labels.json`, by entity, with category, source type, source link, confidence and date.
- **Unnamed clusters:** a count by category, each cluster's written rule on this page so the reader has something to open, and a plain statement that their addresses are in `labels/labels.csv` in the repo, not on this site, so they can't be checked from here until the repo is public.
- **Settings in this dataset:** `manifest.definitions`, including the velocity formulas, rendered as values.

**Known limits, stated plainly.** The page shows `summary.known_limits`, which changes with coverage, then these, which it doesn't carry. The doc lists both. Each numeric limit gives the date it was measured.

| Limit | From |
|---|---|
| Base balances are a sample of 50 wallets a run, not a census | Build log, first full reconciliation |
| If Blockscout lags past its 2,000 block tail, ordinary transfers can be missed, and only the sampled balance check would catch it | Build log, Known gaps |
| Whether Blockscout and RPC give the same `logIndex` hasn't been checked | Build log, Known gaps |
| Placed lags by 14 days, and isn't charted before its first valid day | Brainstorm |
| A few large transfers dominate clean volume: 81 transactions were 97% of Tempo's, and those inspected looked like holders moving between wallets, which public evidence can't confirm | Brainstorm |
| The Tempo fee rule was tested on a sample, with a true miss rate below about 0.9% by count, and well under a dollar at risk | Brainstorm |
| DEX flow isn't trading, and we ingest no swaps | Brainstorm |
| Bridge's small-ticket issuance is excluded from clean volume and isn't shown live | Brainstorm, this plan |
| A stale note appears only once a rebuild or the reader's clock shows it, so a failed run can take up to 36 hours to show on a page that wasn't rebuilt | This plan |

Engineering limits with no bearing on a reader's numbers, such as secret scrubbing gaps and hand-guarded files, stay in the build log, and the page links there.

**Test scenarios**
- Happy path: every anchor in `definitions.ts` exists in the rendered page, and every PRD section 7 metric has one.
- Error path: raw HTML in the doc, or a missing mapped heading, fails the build.
- Error path: the legend in `docs/methodology.md` must equal the section in `labels/README.md`. A one-word change fails.
- Happy path: every `source_type` in `labels.json` appears in the legend.
- Happy path: the named labels table has every named entity. `derived_rule` rows contribute only to counts.
- Error path: a named row with a `javascript:` or other non-`https` source fails the build, and isn't dropped. `derived_rule` rows are exempt, because they point at a rule and are never linked.
- Happy path: every `derived_rule` category in the sample has rule text on the page.
- Happy path: each limit in the table above, and each non-conditional `known_limits` entry in the sample, is in the document, and each numeric one has a date.
- Happy path: the doc's stated defaults equal the constant in `definitions.ts`, and the stated verdict thresholds equal `PLACED_THRESHOLD_BPS` and `EVERYDAY_THRESHOLD_BPS` (a pytest in `tests/test_site_fixtures.py`).
- Happy path: the four contract addresses appear exactly, including Solana's case.

**Verification:** a reader can go from any chart's definition link to the right heading, then to a label's source. Evidence at 390 and 1440.

---

- [ ] **Unit 3.5: README and repo polish**

**Goal:** a stranger can read the repo and run the site.

**Dependencies:** 3.1a to start. Merges after 3.4, so links resolve.

**Files**
- Modify: `README.md`, `docs/build-log.md`, `docs/implementation-plan.md`, `docs/PRD.md`

**Approach**
- README: status, what the site shows, how to run it (`make web-shots` needs a browser download; `make web-release` needs a real dataset), the web tools in the module table, and links to methodology.
- Build log: a Phase 3 entry for what went wrong, including the Corepack failure, the peer dependency pins and the stale-at-build flaw in the first schema's wording.
- Implementation plan: point Phase 3 here and use these unit numbers.
- PRD section 6: note how views A and E are worded here, and why. Note in section 11 that the PRD's phase numbers differ from the implementation plan's, where independent review is Phase 4.

Test expectation: none. Docs only, and `make check` covers formatting. This PR touches no `web/**`, so it needs no `## Evidence`.

**Verification:** a clean clone can follow the README to a local build of the sample site. Every relative link resolves.

---

- [ ] **Unit 3.6: Mobile, accessibility and browser acceptance**

**Goal:** prove the whole site, and fix what that finds.

**Dependencies:** all of the above. For the real-data part, a published dataset that passed every check, from a run the coordinator makes. Read only a copy of `data/published/latest`, never `data/ousd.duckdb` or `.env`.

**Files**
- Modify: fixes only, anywhere under `web/`
- Test: added to the owning unit's existing test file when a fix needs a regression test

**Approach**

Run in a real browser at 320, 390, 768, 1056 and 1440:

| Check | Pass means |
|---|---|
| Sample builds (`complete`, `partial`) | Frame on every page, every view renders, one card cropped alone still reads as not real |
| Real preview, if `make preview` has run | Preview wording, same frame. Reported as not run otherwise |
| Stale (fake browser clock) | On a sample, the note appears in place with no layout shift, the data stays, and the strip still says "Not reconciled". On real data, the strip changes too |
| Bad dataset | Build exits non-zero, with the file and field named |
| Release mode on sample or preview | Refuses |
| Real dataset, `make web-release` | Builds and renders, with the live strip. Numbers match a direct read of the published JSON. Reported as blocked, not passed, if no such dataset exists yet |
| Real dataset, marked stale by a refused publish, then rebuilt | Shows "A newer run did not pass its checks", if one has happened. Reported as not run otherwise |
| Layout | No horizontal page scroll at any width. Charts stack below 1056. Independence line visible at every scroll position |
| Keyboard | Full use, visible focus, skip link, accordions work, charts not in the tab order |
| Axe (`@axe-core/playwright`) | No serious or critical violations, contrast included |
| Screen reader basics | Each chart has its text summary and table, and the graphic is hidden |
| Reduced motion | No animation |
| Touch | Nothing essential is only in a tooltip |
| JavaScript off | Text, tables, as-of times, the independence line and the chart note are all there. An aged build's strip still reads as dated, not current |
| Network tab | No third-party request |
| Design system | Tokens, type, hairlines, no shadows, no pie charts or gradients, takeaway as title |

**Test scenarios:** the table above is the scenario list. Any fix adds a regression test in the owning unit's test file.

**Verification:** `## Evidence` has every state at every width, with refusals as pasted text. **No deployment.**

## Fact, estimate and opinion

| On the page | Chip | Why |
|---|---|---|
| Minted, burned, net supply, reconciliation results | **Fact** | Read directly from the chain, and reconciled to it |
| Headline volume, transfer counts | **Fact** | Read directly from the chain, and only partly covered by sampled balance checks, which the methodology page says |
| Issuer inventory, venue supply, DEX and lending flow | **Inferred** | Rests on published labels |
| Placed, free-floating, circulating, clean volume, everyday and large, velocity, active wallets, Tempo fees | **Inferred** | A written rule applied to chain data |
| `verdict.text` | **Inferred**, or **Estimate** at partial scope | States rule-based numbers, so it carries their chip. At partial scope it also states an estimated share |
| `verdict.estimates`, such as share of OUSD on the chains covered | **Estimate** | Rests on a stated assumption. View F's reserve income comes later |
| Display sentence, `verdict.opinions` | **Our reading** | An opinion about the facts |

A takeaway only states numbers, so it carries the chip of those numbers. Takeaway functions are pure, tested, and return the unknown text rather than guessing.

**No name without a source.** The main page names only the four chains, Bridge and Open Standard, in the independence line and where issuer flows are explained. Named wallets appear only on the methodology page, each with its source. `verify-output` enforces this. Voice follows the design system: "wallet", not "user", and no predictions about partners.

## Evidence for web PRs

The merge gate refuses a PR touching `web/**` unless `## Evidence` holds at least one link or image.

**Where screenshots come from.** `make web-shots`, from 3.1a, builds each available state, serves it on localhost only and captures it with headless Playwright at the five widths, into `web/.shots/`, which `web/.gitignore` excludes. The browser is a local download through Playwright, and neither it nor this step runs in CI. A PR may capture only the pages it changed, at 390 and 1440. Unit 3.6 captures everything.

**How they're linked.** The repo is private, and `gh` can't upload to PR attachments. So each PR pushes its PNGs as one orphan commit to its own branch, `evidence/<unit>`, holding only those images under `shots/<unit>/<page>-<state>-<width>.png`. `## Evidence` links to them pinned to that commit (`.../blob/<sha>/shots/...png?raw=true`), as an image and as a plain link. These branches never merge, squash merges can't carry them into `dev`, and CI doesn't run on them. Whether images render inline in a private repo hasn't been checked. The plain link satisfies the gate either way, and 3.1a checks it first.

**What must never be in a screenshot:** `.env` contents, any RPC URL, a terminal, browser chrome or desktop, local paths, wallet addresses other than the token contracts, personal details. Headless page captures avoid nearly all of this. `web-shots` never loads `.env`. A failed build makes no page, so refusals go in `## Evidence` as pasted text, which errors keep free of absolute paths.

**Sample or real.** Captions say "Sample data" or "Real dataset, {dataset_version}". Only 3.6 uses real data, and it's aggregates only.

**Assume these are public eventually.** Deleting a branch doesn't remove a commit GitHub can still serve by SHA, and PR bodies keep the links. Screenshots are safe to go public by construction, being sample data or aggregates under the rules above. Deleting `evidence/*` before launch only tidies up.

## Owner actions

| When | Action |
|---|---|
| **Only if** 3.1a's "Build and test" shows Node or npm missing, or out of range | Add a step before `make check` in `.github/workflows/ci.yml`: `uses: actions/setup-node@v4` with `node-version: 22`. Nothing else in CI should change, since the Makefile fetches pnpm itself. Expected not to be needed. Until then, 3.1a stays red and unmerged, and every other PR is unaffected |
| Optional | Pin Node with the same step anyway, since `ubuntu-latest` can change it. If it leaves `^22.12 \|\| ^24`, `make check` fails with a clear message, not silently |
| Before 3.2 merges, and best before 2.8 merges | Review the verdict sentences and 2.8's templates, as the brainstorm asks. Read them again against real data in Phase 4 |
| Before any public release | Review `labels/labels.csv`, as the brainstorm asks, especially naming a vault in a story about parked money. Note the methodology page shows every named label, wider than the insight models plan's "similar named venues" |
| Before any public release | Decide who runs the pipeline and rebuilds, and how often. With no hosted schedule, the page goes stale 36 hours after its last build, and a failed run shows only after a rebuild. Decide whether to add a manual correction notice |
| Before any public release | Have someone new to OUSD read the first screen and say what it answers, per PRD section 12 |
| Before any public release | Confirm the repo URL in `web/lib/site.ts`, and that the repo is public so `labels/labels.csv` can be checked. Delete `evidence/*` branches |
| Any local setup that calls a bare `pnpm` | Use `make web-install` instead, because of the Corepack failure above |

## Risks

| Risk | Response |
|---|---|
| 2.8 changes the schema | Its files win. Only 3.1c reads raw fields, generated types catch drift, and 3.1c re-opens 3.2 and 3.4 if states, limits or the legend moved |
| 2.8 hasn't merged when the fan-out should start | 3.1a and 3.1b proceed. 3.1c waits. No copy of the schema gets written meanwhile |
| The first Linux run behaves differently from macOS | 3.1a's PR proves it before anything depends on it |
| No full published dataset exists at acceptance | 3.6 reports the real-data check as blocked. Phase 3 isn't done until it passes |
| A failed run isn't visible until a rebuild | `mark_stale` records it, and the next build shows it. A page nobody rebuilds relies on the clock, up to 36 hours. Accepted for a local-only phase, and a Phase 4 decision before release |
| The live strip isn't seen on screen until real data exists | Accepted, so that no build ever shows it on sample numbers. Its test covers the text, and it's cheap to fix in 3.6 |
| The runner's Node moves out of range | `make check` fails loudly with a message, and pinning is a one-step owner change |
| A sentence goes false as data changes | Takeaways and the verdict sentence state only what their conditions establish, tested at their boundaries, and data-dependent limits carry dates |
| A sample or preview gets mistaken for the real thing | No off switch, a frame on every page and card, and `verify-output` on every build |
| CI gets slower | Cold install and two builds on Linux are unmeasured. The job's limit is 30 minutes, and 3.1a reports the time. Caching would be an owner change |
| Mobile first screen gets crowded | Short sentence, an 88px header budget, a banner that scrolls away, and 3.6 checks at 390x844 |

## Deferred

- **To implementation:** the `next-env.d.ts` approach; the test DOM; exact Recharts composition for the waterfall; the exact shape of `shots.mjs`; exact fixed heights for the chart area.
- **To later phases:** Bridge's small-ticket issuance as a live line (needs a mart column and a schema change); CSV downloads; views C, D and F; a state change that needs more than one run to flip, near a boundary; security headers; where a hosted build gets its dataset, since `data/` isn't in git and the site reads schemas from outside `web/`, and how that build goes through the release gate. A public release needs an answer to that last one.

## Phase done when

- `make check` is green in CI with the web steps running.
- A build from a real published dataset renders, passes on mobile, and matches `docs/design-system.md`.
- Sample, stale and live behaviours are shown in `## Evidence`, with refusals as text. Preview wording is too, if `make preview` has run, and is otherwise proved by its test.
- Every chart has its takeaway, source, as-of time and definition link, enforced by types and `verify-output`.
- Nothing has been deployed.
