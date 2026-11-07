# Architecture

**Status:** binding. If a decision here is missing or wrong, change this file in the same pull request.

## Purpose

Two things decide every choice here:

1. **Trustworthy data:** anyone should be able to check the numbers, from raw chain data to the published figure.
2. **Useful insight:** every model exists to answer a question in `docs/PRD.md`. A table that doesn't feed a question doesn't get built.

Prefer a small system that's clearly correct over a big one that looks impressive.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | Python 3.12, managed with uv | Standard for data work. Fast, reproducible installs |
| Sources | JSON-RPC, Blockscout, Bridge transparency API | Raw data, free where possible |
| Warehouse | DuckDB file | Free, serverless, real SQL. Can move to Postgres or MotherDuck later |
| Modeling | dbt with dbt-duckdb | Standard for analytics. Tests and lineage come with it |
| Orchestration | Dagster assets, with asset checks | Asset model suits data work. Checks can block publishing |
| Site | Static Next.js with TypeScript, Tailwind and Recharts, on Vercel | No database calls from visitors |
| Hosting | One Railway cron service runs the daily job and deploys a prebuilt Vercel preview; production is promoted by hand | One writer, one volume, nothing listening. See [deploying the daily run](deploy.md) |
| Site packages | pnpm, always through `npx` at the version in `web/package.json`'s `packageManager` | Needs only Node and npm, which CI already has. [Operations](operations.md#the-site) says why not a bare `pnpm` |
| Quality | ruff, mypy, pytest, sqlfluff, ESLint, Prettier, Vitest | Enforced by `make check` |

**Cost:** a few dollars a month: one daily Railway run of about 35 minutes and a small volume. The site is static, on Vercel's free tier.

**Hosted schedule:** Railway is the current host. Moving to another would change only the service's settings. Its cron runs `scripts/daily.sh` instead of the Dagster schedule, which stays off. The DuckDB files live on the service's volume, which has no backups: a lost volume is rebuilt from the chains, which takes hours because of Blockscout's rate limits, or restored from a copy taken by hand (see [backup and restore](operations.md#backup-and-restore)).

**No Dagster partitions (decision):** ingest is cursor-based and idempotent, and dbt rebuilds in seconds, so partitions would add a second backfill path that could disagree with the cursor. dbt runs as one asset for the same reason. A missed day is caught up by the next run, which reads from the cursor. Revisit only if a rebuild stops taking seconds.

**Orchestration:** one Dagster job, `ousd_daily`, runs four assets in order: `raw_transfers`, `chain_reconciliations`, `dbt_marts`, then `published_dataset`. The blocking checks are asset checks on `dbt_marts`, so a failed check stops the run before publish, marks the last published dataset stale and publishes nothing. Ingest and reconciliation retry twice, five minutes apart, on a source error. A failed check or a reconciliation that isn't a full pass never retries. The schedule (06:00 UTC daily) and a failure sensor ship **stopped**: they run only while the Dagster UI is up and someone has switched them on. A failed run writes an alert file from a failure hook inside the run, and a run-scoped resource limits its time. Dagster's state lives in `data/.dagster`. Alerts, the heartbeat and the limits are in [operations](operations.md).

## Layout

```
pipeline/ousd/      Python package: chains, sources, ingest, store, reconcile, probes, publish, backup, cli
pipeline/dagster/   Dagster definitions, schedules and asset checks
dbt/                dbt project: staging, intermediate, marts, tests
labels/             Versioned entity labels, each with source type, source and confidence
web/                Static site. Reads the published dataset, its schemas and the methodology doc
tests/              Python tests. No network, ever
docs/               PRD, architecture, operations, roadmap, design system, methodology, lessons learned
data/               Local DuckDB and published output. Not in git
```

## Data flow

```
Chains and APIs
   | sources: paged, throttled, retried
   v
raw tables in DuckDB (idempotent, reorg-aware)
   | reconcile: events against totalSupply, to the base unit
   v
dbt staging -> intermediate -> marts, with tests
   | Dagster asset checks
   v
publish step, only if every blocking check passes
   | versioned JSON and CSV with a data-as-of time
   v
static site
```

If a check fails, nothing publishes and the site keeps the last good data, marked as stale. The mark is a `stale.json` beside the folder's files, with the time it went stale and why, so a published folder's own files never change.

## Chains

| Chain | Token | History | Tip | Finality |
|---|---|---|---|---|
| Tempo (4217) | `0x20c0000000000000000000006a37DA5C996874BE` | Public RPC | Public RPC | Finalized matched tip when checked |
| Ethereum | `0x9f6F3991D525015a6F8CaF062C83b62fD3AC4436` | Blockscout | RPC | Roughly 76 blocks behind tip when checked. State by number about 100 blocks on public nodes |
| Base | `0xB2000000000000000000002fEb517dFeC7415344` | Keyed RPC (`BASE_RPC_URL`) | RPC | Roughly 600 blocks behind tip when checked |
| Solana | `ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB` | Keyed RPC (`SOLANA_RPC_URL`) | RPC | Use `finalized` commitment |

Always filter by these addresses. The OUSD ticker also belongs to Origin Dollar.

Provider differences stay inside `sources`. Everything after that works on normalized rows.

## Core data rules

- **Amounts are integers in base units** (6 decimals). Never floats, in Python or SQL.
- **Idempotent writes.** The key is chain, block or slot, and log index. On Solana, `log_index` is `(transactionIndex << 12) | position`, so it's unique in the slot and in execution order. Re-running any range changes nothing.
- **Reorgs.** Store block hashes, re-check a per-chain lookback at the tip, and replace orphaned rows. Test with simulated reorgs and say plainly that this is how it was tested. Solana reads only `finalized`, so it stores no block hashes and has no reorg repair.
- **Raw is immutable** except for reorg repair. All interpretation happens in dbt.
- **Time is UTC.** Day 0 is 2026-09-30, but ingest from the first mint.
- **Marts live in their own file.** dbt attaches `data/ousd.duckdb` read-only and writes `data/marts.duckdb`, so modeling can't change raw data.

## Schema changes

- **Every change to the raw store's schema is a new migration** at the end of `MIGRATIONS` in `pipeline/ousd/migrations.py`, numbered one above the last. A migration that has shipped is never edited, because a database that applied it would never see the edit.
- `schema_migrations` records each applied version, its name and when. Version 0 is the baseline, the schema as it stood before versioning: a database without the table is brought to it in place, adding only what it lacks.
- A writer reads what is pending and applies it in one transaction when it opens the store. With nothing pending it writes nothing. Every open refuses a schema newer than the code, and a database whose recorded migration names differ from the code's.
- Readers (`Store(path, read_only=True)`) run no DDL and never write. They can share the file with other readers, never with a writer: DuckDB locks the file for readers too. With migrations pending they refuse, and say to run `ousd migrate` or any writer first.
- Keep migrations additive where tables are large. `ALTER TABLE ... ADD COLUMN` is cheap in DuckDB; never rewrite `transfers`, which holds millions of rows.
- Rows from before a column existed keep NULL, and the code that reads the column says how it treats them. `reconciliations.run_id` (migration 1) is NULL on older rows. publish matches their figures to a finished run's supply check, as it did before the column existed, but only for a row checked before migration 1 was applied. A NULL row checked later belongs to no run, and publish refuses it. A row with a `run_id` counts for that run only when the run's own passing supply check has the same pin and figures.

## Blocking checks

Publishing stops if any of these fail:

1. **Per-chain supply:** mints minus burns equals `totalSupply()` (or Solana's `getTokenSupply`) at the same block or slot, exactly.
2. **Cross-chain supply:** the sum of chains, from events proved by check 1, equals Bridge's reported total to the base unit, taking each chain's supply at some block from 5 minutes before to 1 minute after Bridge's own `last_updated` time. Any of 3 attempts, on different snapshots 10 minutes apart, may pass. A snapshot over 30 minutes old is unchecked.
3. **Sampled balances:** model balances equal `balanceOf` for a sample of wallets, and every same-looking transfer group is proven real from its transaction. A chain with Blockscout history needs one completed census of all wallets. On Solana, every wallet is checked, with one read at one slot.
4. **dbt tests:** the newest dbt command was a full `dbt build`, and every node passed: uniqueness, not-null, accepted values, relationships and unit tests among them. The marts' one `mart_build_params` row must carry the invocation id that build's `run_results.json` records, which shows the marts came from it, and its thresholds must equal `dbt_project.yml` with any `--vars` on that build.
5. **Volume waterfall:** the parts add back up to headline volume.
6. **Freshness:** each chain's newest transfer and reconciliation are within 36 hours.

Only exit 0, with all four chains and Bridge passed, allows publishing.

Non-blocking: changes that look wrong, such as a large jump in any metric, produce warnings for human review.

## Models

Marts map to PRD questions. Definitions are in PRD section 7, and these are the first ones:

| Mart | Answers | PRD view |
|---|---|---|
| `mart_supply_journey` | How much is placed, in venues, circulating or active? | A |
| `mart_exchange_holdings` | What do wallets named as each exchange's hold? | Methodology |
| `mart_activity_waterfall` | How much of the headline volume is real? | B |
| `mart_activity_kpis` | What are velocity and active wallets? | B |
| `mart_chain_roles` | What is each chain used for? | E |
| `mart_reconciliation` | Do the numbers hold up? | Trust strip |
| `mart_partner_evidence` (later) | Who shows evidence of going live? | C |
| `mart_peer_benchmarks` (later) | How does it compare at the same age? | D |
| `mart_partner_economics` (later) | What could reserve income be worth? | F |

**Tempo fee transfers:** about 44% of Tempo transfers by count and about $23 by value. The rule is a transfer to the fee manager `0xfeec000000000000000000000000000000000000` that is the last OUSD transfer in its transaction, tested against receipts. Filtering on the address alone also catches fee-liquidity transfers, including the largest at 50 OUSD.

## Labels

- One versioned file, `labels/labels.csv`, with the columns `chain,address,entity,category,source_type,source_url,confidence,date_checked`.
- Source types: `explorer_tag`, `project_docs`, `company_docs`, `official_statement`, `published_research`, `onchain_metadata` and `derived_rule`. `derived_rule` is only for unnamed clusters, and points at the rule that defines them.
- Only named when a public source ties the name to the address. Everything else stays an unnamed cluster. Private individuals are never labeled.
- `labels/README.md` holds the source legend. The site and methodology page carry it, so a reader can see how we know each label.
- A label change is a reviewed change, because labels affect published claims.

## Published dataset

- JSON per view, plus CSV for download.
- A manifest with data-as-of time, check results and provenance: the full git commit, and `tree_state` (`clean`, `dirty`, or `unknown` in the image, which has no checkout to read), the SHA-256 of `uv.lock` and of the compiled `dbt/target/manifest.json`, the Python, dbt-core and dbt-duckdb versions, and the raw store's highest applied migration.
- Published folders are immutable. A stale mark goes in `stale.json` beside them, never into the manifest.
- `make web-release` refuses a dataset published from a dirty tree, as it refuses sample and preview data. Any other build shows it as a local preview. Only `dirty` is refused: `unknown` passes, as the image has no checkout to read, and so does a version 2 manifest, which recorded no tree.
- Numbers as strings where precision matters, with a schema the site validates at build. The schemas are in `pipeline/ousd/schemas/`. The manifest is at version 3; the other files are at version 2. Version 2 of the manifest, which held its own stale fields and no provenance, is kept as `manifest.v2.schema.json`, so a site still loads a dataset published before version 3 and still shows its stale mark. When a `stale.json` sits beside a version 2 manifest, the `stale.json` wins.

## Site

- Follows `docs/design-system.md`. Reads the published dataset, plus its schemas and `docs/methodology.md`, at build. Visitors' browsers read nothing else.
- Every chart has a takeaway sentence, source, as-of time and definition link.
- Shows "Independent. Not affiliated with Open Standard or Bridge."

## Security and secrets

- Keys only in `.env`, which is gitignored. `.env.example` holds public defaults and lists keyed values by name only.
- Never log or raise an RPC URL or any part of it, because a bare key leaks just the same.
- The backup credentials, `OUSD_BACKUP_ACCESS_KEY_ID` and `OUSD_BACKUP_SECRET_ACCESS_KEY`, are secrets the same way. A failed object storage call reports only its step and the provider's error code.
- Changes to `pipeline/ousd/reconcile.py`, `pipeline/ousd/publish.py` and `labels/**` get extra review, because they decide what gets published. `reconcile_solana` and the balance checks in `solana.py` get the same review as `reconcile.py`.

## Code standards

- Small modules with one job. Type hints throughout. Clear names over comments; comments explain why.
- Tests cover behavior and edge cases: paging boundaries, idempotent re-runs, reorg replacement, reconciliation failures. Tests never use the network.
- No speculative abstractions. A second chain justifies an interface; an imagined fifth doesn't.
- Conventional Commits, with an area as the scope: `pipeline`, `dbt`, `web`, `docs`, `ops` or `deps`, for example `fix(dbt): count mints once`. Every pull request has `## Decisions`. Pull requests that change the site add `## Evidence`.
- [Lessons learned](build-log.md) records what went wrong, honestly.

## Commands

`make check` runs lint, types and tests for the Python code, then, once `web/package.json` exists, installs the site's packages and runs Prettier, ESLint, `tsc`, Vitest and a build of both sample sites. It has no chain access, though a clean install reaches package registries. It's the only command CI calls.

`make build` builds what's buildable and `make test` runs tests. The site's targets (`make web-*`) and the rules for running pnpm are in [operations](operations.md#the-site).

The pipeline commands:

| Command | Does |
|---|---|
| `make sync` | Ingest every chain to its tip, repairing any reorg |
| `make reconcile` | Per-chain and Bridge reconciliation. Exit 0 only on a full pass |
| `make models` | `dbt build`: staging, intermediate and marts, with tests |
| `make publish` | Run the blocking checks, then publish only if all pass. A refusal marks the last dataset stale |
| `make preview` | A local, marked-as-preview dataset for site development. Never a release |
| `make run` | `ousd_daily` in one process: ingest, reconcile, dbt, checks, publish |
| `make dagster-dev` | The Dagster UI, where the schedule and failure sensor can be switched on |
| `make backup` | A checksummed copy of the raw database, uploaded when `OUSD_BACKUP_URL` is set. Manual only |

Exit codes, the one-writer rule, keys, backup and restore are in [operations](operations.md).
