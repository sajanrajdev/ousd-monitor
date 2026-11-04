# Open USD Monitor

An independent dashboard asking one question: is Open USD (OUSD) supply turning into money that moves?

Not affiliated with Open Standard, Bridge or any partner. Not financial advice, and not a reserve attestation.

**Status:** the data pipeline ingests Tempo, Ethereum, Base and Solana, and the first full reconciliation passed on 2026-11-04. The dashboard is not built. See [the PRD](docs/PRD.md), [the plan](docs/implementation-plan.md), [the design system](docs/design-system.md) and [the build log](docs/build-log.md).

## Run the pipeline

You need [uv](https://docs.astral.sh/uv/). It installs Python 3.12 and the dependencies.

```sh
make check       # lint, types (mypy) and tests, with no chain access
make sync        # ingest transfers to the tip, repairing any reorg
make reconcile   # compare events with totalSupply(), then with Bridge
```

`make reconcile` checks supply against `totalSupply()` (or `getTokenSupply` on Solana), samples wallet balances, proves same-looking transfer groups from receipts, and compares the four-chain total with Bridge's. Each part is `pass`, `fail` or `unchecked`, and the run ends with one line: `RESULT: FULL PASS`, `RESULT: FAIL` or `RESULT: UNCHECKED`. The exit code says which:

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Full pass: all four chains and Bridge passed | The only code that allows publishing |
| 1 | A proven mismatch, or a crash | Stop and investigate. Don't rerun until it is understood |
| 2 | Usage or configuration, such as a missing key or a database held by another process | Fix the setup and rerun |
| 3 | Nothing is proven wrong, but something wasn't checked | Read the reasons. Usually rerun later, or run `make sync` first |

Bridge's comparison counts: a Bridge error or mismatch stops exit 0. It uses Bridge's own `last_updated` time, taking each chain's supply at some block from 5 minutes before to 1 minute after it, with no tolerance in the amount. Any `--chain` or `--at-block` run is a partial check, so it exits 3 even when it prints `MATCH`. `make` turns any failed recipe into exit 2, so use `uv run --locked --env-file .env ousd reconcile` when the code matters. On Solana the check reads every wallet's balance, and a check that could not run prints `UNCHECKED`. Run it straight after `make sync`, because public Ethereum nodes only serve about 100 blocks of past state.

The first full run, which also reads every Tempo and Ethereum wallet, takes longer than later ones:

```sh
make sync
uv run --locked --env-file .env ousd reconcile --census tempo --census ethereum
uv run --locked --env-file .env ousd reconcile   # every later run
```

Run one writer at a time. `sync` and `reconcile` both write to the same DuckDB file, and the second to start exits 2 with "database in use". Wait for the first to finish.

The first Ethereum sync can take hours. Blockscout's free tier allows few requests per window, and the client waits each window out, logging every pause of 5 seconds or more. An interrupted sync resumes from where it stopped.

Data goes to `data/ousd.duckdb`, which git ignores. Tempo and Ethereum settings are optional and have a public default. Base and Solana have no public endpoint, so `make sync` and `make reconcile` need `BASE_RPC_URL` and `SOLANA_RPC_URL`. `SOLANA_RPC_URL` is a Solana mainnet RPC URL, key included, and a devnet URL is refused. Solana reads only finalized data, runs first when no `--chain` is given, and does not support `reconcile --at-block`. For public chains alone, run `uv run --locked ousd --chain tempo --chain ethereum sync`, and the same for `reconcile`. To use your own provider, copy `.env.example` to `.env`.

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

- **Idempotent:** a transfer's key is chain, block or slot, and log index. Each range and its cursor commit together. Reading a row again changes nothing, and a different row at the same position stops the sync.
- **Paging:** a Blockscout page may end inside a block, so that block is requested again from its start. A range ends only on a response with nothing past its first block, not on a short page. Blockscout never serves unfinalized blocks, because its rows have no block hash.
- **Reorgs:** each run compares stored block hashes with the chain, newest first, and rolls back to the first match. That relies on the stored hashes being one chain, so a new block must extend the stored block below it. The window covers at least the lookback and every unfinalized block. Reorgs here are rare, so this is tested with simulated reorgs only.
- **Late logs:** each run reads the newest stored blocks again, in case a lagging node returned too few logs the first time.
- **Failures:** each HTTP attempt has a 120 second deadline, and failures are retried with backoff. Provider URLs never reach logs or errors, as they can hold keys.
- **Reconciliation:** `totalSupply()` is read by block hash, so it can't land on a competing fork. Bridge's total is compared with the sum of all four chains, each at a block near Bridge's own time.
