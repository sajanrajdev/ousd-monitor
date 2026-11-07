# Open USD Monitor

An independent dashboard asking one question: is Open USD (OUSD) supply turning into money that moves?

OUSD is a stablecoin issued by Bridge for Open Standard, with launch liquidity committed by its partners. Supply that partners place is not demand. This project reads the public chain data on Tempo, Ethereum, Base and Solana, checks that its own numbers add up, and shows how much of the supply is placed, how much is held by venues, and how much of the transfer volume is real activity.

**Independent.** Not affiliated with Open Standard, Bridge or any partner. Not financial advice, and not an attestation: it says nothing about the reserves behind OUSD. For reserves, read Bridge's own reports. [The methodology](docs/methodology.md) says what each number means and how far to trust it.

## Status

First public version.

- **Data pipeline:** it ingests all four chains, reconciles them against `totalSupply()` and against Bridge's reported total, models the results with dbt, runs seven blocking checks and publishes a versioned dataset. The latest recorded reconciliation is in [the build log](docs/build-log.md), with the time it ran.
- **Site:** a static site built from the latest dataset that passed every check. Each page shows when its data was read, and warns when that is more than 36 hours old.
- **Daily run:** a Railway cron job runs the pipeline at 06:00 UTC and deploys a preview of the site only when every check passes. Production is promoted by hand. See [deploying the daily run](docs/deploy.md).
- **Next:** tracked in [the plan](docs/implementation-plan.md).

More: [the PRD](docs/PRD.md), [the architecture](docs/architecture.md) and [the design system](docs/design-system.md).

## Run it

You need [uv](https://docs.astral.sh/uv/), which installs Python 3.12 and the dependencies. The site also needs Node 22.12 or newer and npm.

```sh
make check   # lint, types and tests for the pipeline and the site, with no chain access
```

`make check` needs no `.env`. A clean install does reach package registries.

### From chain data to a published dataset

Do these in order the first time. Run one writer at a time: `sync`, `reconcile`, `models`, `publish` and `run` all use the same DuckDB file at `data/ousd.duckdb` (git ignores `data/`), and the second to start exits 2 with "database in use".

```sh
make sync                                                                                    # ingest transfers to the tip, repairing any reorg
uv run --locked --env-file .env ousd reconcile --census tempo --census ethereum             # the first full reconcile reads every wallet too
make models                                                                                  # dbt: raw to staging to marts, with tests
make publish                                                                                # run the checks, then publish only if all pass
```

Later runs skip the census: `make sync`, `make reconcile`, `make models`, `make publish`. Or run the whole thing in one process:

```sh
make run         # ingest, reconcile, dbt, seven checks, publish
make dagster-dev # the Dagster UI, to switch on the daily schedule
```

Reconcile straight after sync, because public Ethereum nodes only serve about 100 blocks of past state. The first Ethereum sync can take hours: Blockscout's free tier allows few requests per window, and the client waits each window out, logging every pause of 5 seconds or more. An interrupted sync resumes where it stopped.

### Keys

Tempo and Ethereum have public default endpoints. Base and Solana have none, so `make sync`, `make reconcile` and `make run` need a keyed RPC URL for each, `BASE_RPC_URL` and `SOLANA_RPC_URL`, in `.env`. Copy `.env.example` to `.env`. `SOLANA_RPC_URL` is a Solana mainnet URL, key included, and a devnet URL is refused. Keys live only in `.env`, which git ignores, and never reach logs or errors. Solana reads only finalized data, runs first when no `--chain` is given, and does not support `reconcile --at-block`.

To run public chains alone: `uv run --locked ousd --chain tempo --chain ethereum sync`, and the same for `reconcile`. That is a partial check and cannot publish a release.

### Reconciliation and exit codes

`make reconcile` checks supply against `totalSupply()` (or `getTokenSupply` on Solana), samples wallet balances, proves same-looking transfer groups from receipts, and compares the four-chain total with Bridge's. Each part is `pass`, `fail` or `unchecked`, and the run ends with one line: `RESULT: FULL PASS`, `RESULT: FAIL` or `RESULT: UNCHECKED`. The exit code says which:

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Full pass: all four chains and Bridge passed | The only code that allows publishing |
| 1 | A proven mismatch, or a crash | Stop and investigate. Don't rerun until it is understood |
| 2 | Usage or configuration, such as a missing key or a database held by another process | Fix the setup and rerun |
| 3 | Nothing is proven wrong, but something wasn't checked | Read the reasons. Usually rerun later, or run `make sync` first |

Bridge's comparison counts: a Bridge error or mismatch stops exit 0. It uses Bridge's own `last_updated` time, taking each chain's supply at some block from 5 minutes before to 1 minute after it, with no tolerance in the amount. Any `--chain` or `--at-block` run is a partial check, so it exits 3 even when it prints `MATCH`. `make` turns any failed recipe into exit 2, so use `uv run --locked --env-file .env ousd reconcile` when the code matters. On Solana the check reads every wallet's balance, and a check that could not run prints `UNCHECKED`.

### The daily run

`make run` runs the Dagster job `ousd_daily` in one process: `raw_transfers`, `chain_reconciliations`, `dbt_marts`, then `published_dataset`. It needs `BASE_RPC_URL` and `SOLANA_RPC_URL`, like `make sync`. The seven checks are blocking checks on `dbt_marts`, so a failed one stops the run before publish, marks the last published dataset stale, and publishes nothing. A reconciliation that isn't a full pass, or a failed dbt build, stops it the same way. Ingest and reconciliation retry twice, five minutes apart, when a source errors. A failed check or reconciliation never retries. Dagster's own state is kept in `data/.dagster`.

The schedule (06:00 UTC every day) and the failure sensor are off until switched on in the UI that `make dagster-dev` serves, and run only while it is up. A failed run writes `data/alerts/<run_id>.json`, including under `make run`. Nothing is sent anywhere unless `OUSD_ALERT_WEBHOOK_URL` or `OUSD_HEARTBEAT_URL` is set. Don't run `make run` while another sync or `ousd` command holds the database.

## The site

The site is static Next.js. It reads a published dataset at build time, and visitors' browsers read nothing else. Every command goes through `npx` at the pnpm version in `web/package.json`, because a bare or Corepack `pnpm` can crash. None of them load `.env`, and web code never reads an RPC variable.

```sh
make web-install   # install the site's packages
make web-samples   # build both bundled samples, which are marked as samples on every page
make web-build     # build from OUSD_DATASET_DIR, else data/published/latest, else the sample
make web-release   # a release build: refuses sample, preview and unchecked data
make web-browser   # download the browser that make web-shots needs
make web-shots     # local screenshots of the samples
```

`make preview` writes a local preview dataset outside `data/published`, for site development. A preview is marked as one and is never a release. `make web-release` needs a real dataset from a run whose checks all passed. If that dataset carries warnings, the release prints each one and refuses until `OUSD_ACK_WARNINGS` is set to the dataset's version, or until every warning's `chain:metric` is listed in `OUSD_ACK_WARNING_KEYS` (comma-separated, for a known warning on an unattended run; the listed keys are logged on every release). The hosted daily run is described in `docs/deploy.md`.

## How it works

| Module | Job |
|---|---|
| `chains.py` | Per-chain settings: token, start block, range limits, reorg lookback |
| `http.py` | Throttling, retries with backoff, and honoring rate limit hints |
| `sources.py` | JSON-RPC, Blockscout paging and Bridge's API |
| `decode.py` | Transfer logs to integers and addresses |
| `store.py` | DuckDB tables. Amounts are `HUGEINT` base units, never floats |
| `ingest.py` | Idempotent sync and reorg repair |
| `solana.py` | Solana ingestion from finalized data, and its supply and balance checks |
| `probes.py` | One reader per chain, so `reconcile.py` stays chain-agnostic |
| `reconcile.py` | Mints minus burns against supply at the same block, sampled balances, same-looking groups and the Bridge check |
| `checks.py` | The seven blocking checks |
| `publish.py` | The versioned dataset the site reads, written only if every check passed |
| `pipeline/dagster/` | The daily job, its schedule and failure sensor |
| `dbt/` | Staging, intermediate and mart models, with tests |
| `labels/` | Entity labels, each with its public source and confidence |
| `web/` | The static site and its build and release scripts |

- **Idempotent:** a transfer's key is chain, block or slot, and log index. Each range and its cursor commit together. Reading a row again changes nothing, and a different row at the same position stops the sync.
- **Paging:** a Blockscout page may end inside a block, so that block is requested again from its start. A range ends only on a response with nothing past its first block, not on a short page. Blockscout never serves unfinalized blocks, because its rows have no block hash.
- **Reorgs:** each run compares stored block hashes with the chain, newest first, and rolls back to the first match. That relies on the stored hashes being one chain, so a new block must extend the stored block below it. The window covers at least the lookback and every unfinalized block. Reorgs here are rare, so this is tested with simulated reorgs only.
- **Late logs:** each run reads the newest stored blocks again, in case a lagging node returned too few logs the first time.
- **Failures:** each HTTP attempt has a 120 second deadline, and failures are retried with backoff. Provider URLs never reach logs or errors, as they can hold keys.
- **Reconciliation:** `totalSupply()` is read by block hash, so it can't land on a competing fork. Bridge's total is compared with the sum of all four chains, each at a block near Bridge's own time.

## License

[MIT](LICENSE). The data comes from public chains and Bridge's public API; the entity labels in `labels/` each cite their own public source.
