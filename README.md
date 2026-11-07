# Open USD Monitor

An independent dashboard asking one question: is Open USD (OUSD) supply turning into money that moves?

OUSD is a stablecoin issued by Bridge for Open Standard, with launch liquidity committed by its partners. Supply that partners place is not demand. This project reads the public chain data on Tempo, Ethereum, Base and Solana, checks that its own numbers add up, and shows how much of the supply is placed, how much is held by venues, and how much of the transfer volume is real activity.

**Independent.** Not affiliated with Open Standard, Bridge or any partner. Not financial advice, and not an attestation: it says nothing about the reserves behind OUSD. For reserves, read Bridge's own reports. [The methodology](docs/methodology.md) says what each number means and how far to trust it.

## Status

First public version.

- **Data pipeline:** it ingests all four chains, reconciles them against `totalSupply()` and against Bridge's reported total, models the results with dbt, runs seven blocking checks and publishes a versioned dataset. The latest recorded reconciliation is in [lessons learned](docs/build-log.md), with the time it ran.
- **Site:** a static site built from the latest dataset that passed every check. Each page shows when its data was read, and warns when that is more than 36 hours old.
- **Daily run:** live on Railway. A cron job runs the pipeline at 06:00 UTC and deploys a preview of the site only when every check passes. Production is promoted by hand. See [deploying the daily run](docs/deploy.md).
- **Next:** see [the roadmap](docs/roadmap.md).

More: [the PRD](docs/PRD.md), [the architecture](docs/architecture.md), [operations](docs/operations.md) and [the design system](docs/design-system.md).

## Run it

You need [uv](https://docs.astral.sh/uv/), which installs Python 3.12 and the dependencies. The site also needs Node 22.12 or newer and npm.

```sh
make check   # lint, types and tests for the pipeline and the site, with no chain access
```

`make check` needs no `.env`. A clean install does reach package registries.

To ingest, reconcile and publish real data you need keyed RPC URLs for Base and Solana in `.env` (copy `.env.example`). [Operations](docs/operations.md) covers the order of the steps, the keys, the reconciliation exit codes, the one-writer rule, the daily run, alerts, and backup and restore.

```sh
make sync        # ingest transfers to the tip, repairing any reorg
make reconcile   # compare the events with each chain's supply and with Bridge's total
make models      # dbt: raw to staging to marts, with tests
make publish     # run the checks, then publish only if all pass
make run         # all of the above in one process
```

Run one writer at a time: these commands share the DuckDB file `data/ousd.duckdb` (git ignores `data/`), and the second to start exits 2 with "database in use". The first full reconcile needs `--census`, and the first Ethereum sync can take hours. Both are explained in [operations](docs/operations.md).

## The site

The site is static Next.js. It reads a published dataset at build time, and visitors' browsers read nothing else.

```sh
make web-install   # install the site's packages
make web-samples   # build both bundled samples, which are marked as samples on every page
make web-build     # build from the newest dataset it finds, else the sample
make web-release   # a release build: refuses sample, preview and unchecked data
```

Always use these targets and never a bare `pnpm`; [operations](docs/operations.md#the-site) says why and lists the rest.

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
