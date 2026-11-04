# Open USD Monitor

An independent dashboard asking one question: is Open USD (OUSD) supply turning into money that moves?

Not affiliated with Open Standard, Bridge or any partner. Not financial advice, and not a reserve attestation.

**Status:** the data pipeline's first slice works for Tempo, Ethereum and Base. Solana and the dashboard are not built. See [the PRD](docs/PRD.md), [the plan](docs/implementation-plan.md), [the design system](docs/design-system.md) and [the build log](docs/build-log.md).

## Run the pipeline

You need [uv](https://docs.astral.sh/uv/). It installs Python 3.12 and the dependencies.

```sh
make check       # lint and tests, with no chain access
make sync        # ingest transfers to the tip, repairing any reorg
make reconcile   # compare events with totalSupply(), then with Bridge
```

`make reconcile` exits non-zero if any chain it checked differs by even one base unit. Exit 0 says only that: the Bridge comparison is printed and does not affect the exit code, and Solana is not checked yet. Run it straight after `make sync`, because public Ethereum nodes only serve about 100 blocks of past state.

The first Ethereum sync can take hours. Blockscout's free tier allows few requests per window, and the client waits each window out, logging every pause of 5 seconds or more. An interrupted sync resumes from where it stopped.

Data goes to `data/ousd.duckdb`, which git ignores. Tempo and Ethereum settings are optional and have a public default. Base has no public endpoint, so `make sync` and `make reconcile` need `BASE_RPC_URL`. For public chains alone, run `uv run --locked ousd --chain tempo --chain ethereum sync`, and the same for `reconcile`. Solana is still pending. To use your own provider, copy `.env.example` to `.env`.

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

- **Idempotent:** a transfer's key is chain, block and log index. Each range and its cursor commit together. Reading a row again changes nothing, and a different row at the same position stops the sync.
- **Paging:** a Blockscout page may end inside a block, so that block is requested again from its start. A range ends only on a response with nothing past its first block, not on a short page. Blockscout never serves unfinalized blocks, because its rows have no block hash.
- **Reorgs:** each run compares stored block hashes with the chain, newest first, and rolls back to the first match. That relies on the stored hashes being one chain, so a new block must extend the stored block below it. The window covers at least the lookback and every unfinalized block. Reorgs here are rare, so this is tested with simulated reorgs only.
- **Late logs:** each run reads the newest stored blocks again, in case a lagging node returned too few logs the first time.
- **Failures:** each HTTP attempt has a 120 second deadline, and failures are retried with backoff. Provider URLs never reach logs or errors, as they can hold keys.
- **Reconciliation:** `totalSupply()` is read by block hash, so it can't land on a competing fork. Bridge's total is only a partial check until all four chains exist.
