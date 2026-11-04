# Open USD Monitor

An independent dashboard asking one question: is Open USD (OUSD) supply turning into money that moves?

Not affiliated with Open Standard, Bridge or any partner. Not financial advice, and not a reserve attestation.

**Status:** the data pipeline's first slice works for Tempo and Ethereum. Base, Solana and the dashboard are not built. See [the PRD](docs/PRD.md), [the plan](docs/plans/2026-11-03-001-first-public-version-plan.md), [the design system](docs/design-system.md) and [the build log](docs/build-log.md).

## Run the pipeline

You need [uv](https://docs.astral.sh/uv/). It installs Python 3.12 and the dependencies.

```sh
make check       # lint and tests, with no chain access
make sync        # ingest transfers to the tip, repairing any reorg
make reconcile   # compare events with totalSupply(), then with Bridge
```

`make reconcile` exits non-zero if any chain differs by even one base unit. Run it straight after `make sync`, because public Ethereum nodes only serve about 100 blocks of past state.

The first Ethereum sync can take hours. Blockscout's free tier allows few requests per window, and the client waits each window out. An interrupted sync resumes from where it stopped.

Data goes to `data/ousd.duckdb`, which git ignores. Every setting is optional and has a public default. To use your own provider, copy `.env.example` to `.env`.

## How it works

| Module | Job |
|---|---|
| `chains.py` | Per-chain settings: token, start block, range limits, reorg lookback |
| `http.py` | Throttling, retries with backoff, and honoring rate limit hints |
| `sources.py` | JSON-RPC, Blockscout paging and Bridge's API |
| `decode.py` | Transfer logs to integers and addresses |
| `store.py` | DuckDB tables. Amounts are `HUGEINT` base units, never floats |
| `ingest.py` | Idempotent sync and reorg repair |
| `reconcile.py` | Mints minus burns against `totalSupply()` at the same block |

- **Idempotent:** a transfer's key is chain, block and log index. Each range and its cursor commit together.
- **Paging:** a full Blockscout page may end inside a block, so that block is requested again from its start.
- **Reorgs:** each run compares stored block hashes with the chain, newest first, and rolls back to the first match. The window covers at least the lookback and every unfinalized block. Reorgs here are rare, so this is tested with simulated reorgs only.
- **Reconciliation:** `totalSupply()` is read by block hash, so it can't land on a competing fork. Bridge's total is only a partial check until all four chains exist.
