---
title: "feat: Add the Base source (Phase 1, unit 1.2)"
type: feat
status: active
date: 2026-11-03
---

# feat: Add the Base source (Phase 1, unit 1.2)

## Overview

Base can reuse the EVM path: `sync_chain`, `Store`, `reconcile_chain` and the data methods of `RpcClient` need no change. This plan adds one foundation unit, because Base is the first chain with no public default, so its URL must hold a key, and `dev` can still leak it. A second unit adds the Base chain entry. The coordinator then runs the real backfill and reconcile.

Units here are named B1 and B2, so they don't read as phase units such as 2.7.

| Unit | What | Paths | Real key or run? |
|---|---|---|---|
| B1 (foundation) | Keep keyed URLs out of logs, errors and repr. Fail clearly when a key is missing | `pipeline/ousd/http.py`, `sources.py`, `chains.py`, `cli.py`, `tests/test_secrets.py` | No |
| B2 | Base chain entry | `pipeline/ousd/chains.py`, `README.md`, `tests/test_base.py`, `tests/fixtures/base_rpc_log.json` | No |
| Real run | Backfill, reconcile and completeness checks | None | **Yes** |

**Schema changes and migrations: none.** All four tables are already keyed by `chain`, and every Base write, rollback and prune is scoped by it, so Base only adds rows. Rows for Tempo and Ethereum in `data/ousd.duckdb` are untouched. The real run still takes a backup first, because those rows took hours to fetch.

**Protected paths: none.** Neither unit touches `.env*`, `reconcile.py`, `publish.py` or `labels/**`. `.env.example` already lists `BASE_RPC_URL=`, added by PR #5.

## Requirements trace

| Requirement | How it is met | Where |
|---|---|---|
| R1 Ingestion | Base `Chain` over `BASE_RPC_URL`, filtered by contract address, from a start block verified on chain | B2, real run |
| R2 Idempotent backfill | Reuses `sync_chain` and `Store.write_range` unchanged. A Base-shaped rerun and an interrupted run are tested, and a second cold backfill is compared in the real run | B2, real run |
| R3 Reorg handling | `reorg_lookback` of 1,200 against a measured finality distance of 505 to 725. Tested with simulated reorgs only, and this plan says so | B2 |
| R6 Reconciliation | `reconcile_chain` runs unchanged on Base, and the result comes from the real run. Sampled balances belong to unit 2.8 and the full Bridge check to unit 1.4 | Real run, Interfaces |
| Architecture: "Never log full RPC URLs" | Closes the gaps listed under B1, with tests | B1 |

## Scope boundaries

- No change to `ingest.py`, `store.py`, `decode.py`, `reconcile.py`, `publish.py`, `Makefile` or `.env.example`.
- No Blockscout for Base. The architecture table binds history to the keyed RPC, and Blockscout rows carry no block hash.
- No provider abstraction, no learned log window, no `blockTimestamp` fallback and no `verify-chain` command. The measurements below answer the questions those would address. Completeness of old log reads is the exception, and the real run checks it.
- No sampled `balanceOf` check and no change to the Bridge comparison, which belong to units 2.8 and 1.4.
- `BRIDGE_API_URL` stays an unkeyed public URL, so B1 leaves the Bridge client as it is.

## What was measured

Read on 2026-11-04 UTC from the keyed PublicNode endpoint with archive access. Tip about 53,485,000. Tests never repeat these reads.

| Fact | Finding |
|---|---|
| Token identity | Chain ID 8453, `name()` "OpenUSD", `symbol()` "OUSD", `decimals()` 6, supply 90,975,001.37 |
| First block with code | **48,631,941**, 2026-07-14 18:20:29 UTC, found by bisecting `eth_getCode`. Block 48,631,940 has none |
| First log of any kind | Also 48,631,941: three logs, none a Transfer |
| First Transfer | **50,497,983**, 2026-08-26 23:01:53 UTC, a 1.000000 OUSD mint from the zero address. No Transfer exists from 48,631,941 to 50,497,982 |
| Supply around those points | Reverts at 48,631,940. 0 at 48,631,941 and 50,497,982. 1,000,000 base units at 50,497,983. 84,834,727.170000 at 52,483,090. Reads by number and by block hash agreed at each block read |
| Range cap | `toBlock - fromBlock` of 50,000 is accepted, 50,001 refused: HTTP 200, `-32701`, "exceed maximum block range: 50000" |
| Result cap | HTTP 200, `-32602`, "query exceeds max results 20000, retry with the range A-B", read on USDC. It refuses instead of truncating, and the text matches the existing `TOO_MANY_RESULTS` |
| OUSD density | 1,583 to 1,590 Transfers per 50,000 recent blocks, 3,311 in a window near tip minus 1M. Under the result cap by a wide margin |
| Repeated reads | One window against the same window split in two returned identical rows (1,583). 8 old 10,000-block windows, read three times each, returned identical rows each time (1 to 635 rows) |
| Cold 50,000-block reads | 12 of 14 succeeded, in 4.5 to 89.9 s. 2 returned HTTP 500, `-32701`, "broker: node error", after 30 s. Repeating one of those ranges took 6.0 s |
| Cold 20,000-block reads | 4 of 5 succeeded, in 2.3 to 13.9 s. 1 hit the 60 s read timeout |
| Cold 10,000 and 5,000-block reads | 12 of 12 succeeded, in 0.4 to 3.1 s. A small sample, mostly from a sparse range |
| Beyond the head | HTTP 200, `-32602`, "block range extends beyond current head block: requested N, head M" |
| Tip consistency | 15 rounds of tip, then block, logs and `eth_call` by hash at that tip: no null block and no errors |
| Finality distance | 9 samples over 3 minutes: 505 to 725, in steps. `finalized` also moved backward between two reads, so backends disagree. An earlier public read saw 492 to 733 |
| `blockTimestamp` on logs | Present on every range checked, including the oldest and newest |
| Rate limit headers | None returned |

Log windows can be slow when cold regardless of how many rows they return: a window with 5 rows took 89.9 s. Tempo's build log shows a documented maximum can be the wrong setting, and that applies here too.

**What this doesn't prove:** that an old log read is always complete. These reads compared a backend with itself, on a sample. Mints minus burns can't see a lost ordinary transfer, so the real run adds checks for that.

## Key technical decisions

Each gives the alternative and the cost of changing later.

1. **`start_block=48_631_941`, the first block with code.** A log can't exist before its contract has code, so this is provable. The build log explains how a suggested block lost an Ethereum mint. Alternative: 50,497,983, the first Transfer, which saves a few calls and depends on the scan being right. Cost to change: one line, plus the Base-only reset under "Real backfill and reconcile" if a cursor exists, because `sync_chain` never reads below its cursor.
2. **`max_log_range=10_000`, not 50,000.** About 486 calls instead of 98. The sample doesn't establish that 10,000 is more reliable. The choice rests on extra calls being cheap and on 50,000 having failed cold reads at 30 s each. Retries and resume cover the rest. Alternative: 20,000, which also saw a timeout. Cost to change: one line.
3. **`reorg_lookback=1_200`.** Safety comes from `_window_start`, which also covers everything above `finalized` if finality stalls. So 1,200 is a fixed floor for hash checks and log re-reads, about 40 minutes of blocks and about 1.6 times the largest distance seen, the same margin Ethereum uses. A fixed floor matters because `finalized` can move backward between backends. Cost: about 1,200 header calls per sync at most, about 2 minutes, and more if finality stalls. Alternative: a smaller floor, which saves little. Cost to change: one line.
4. **Limit errors stay as they are.** The result cap already splits. The range cap can't fire at 10,000, and if it ever did it should stop the run rather than be guessed around. "Beyond current head" raises, and a rerun resumes from the cursor. The HTTP 500 and timeout are already retried by `PoliteClient`. Alternative: recognising a list of messages from other providers, unneeded with one known provider. Cost to change: a few lines in `sources.py`.
5. **Base has no default URL, and blank means unset.** `load_chains` strips the value and stores `""`, so `--chain tempo` still works with no key. PR #5's `.env.example` sets it to an empty string, so unset, empty and whitespace must all behave the same. Alternative: default to public PublicNode, which refuses old ranges with a 403 after a partial backfill. Cost to change: one line.
6. **A missing key exits 2 before the store opens, and `ousd sync` with no `--chain` counts.** A partial sync that looks successful is the failure R6 exists to prevent. `make sync` and `make reconcile` take no `--chain`, so the README gives the direct command for public chains. Alternative: warn and skip Base. Cost to change: low, in `cli.py`.
7. **Keyed chains are listed by name in a mapping in `chains.py`, with no new `Chain` field.** `KEYED_RPC_ENV` maps `base` and `solana` to their variables, and `missing_rpc_keys` reads it. This works whatever config type unit 1.3 uses and leaves `make_chain` alone. Alternative: `Chain.rpc_env`, which assumes Solana uses `Chain`. Cost to change: low.
8. **Scrub the URL's parts, not only the whole URL, and scrub before truncating.** Our key is one 64-character path segment, and `_scrub` today only matches `/key` with its slash, so a provider that echoes the bare key gets through. The new rule also removes each path segment, query value, username, password and host label of 8 or more characters, longest first. Alternative: label-only messages with no provider text, which loses the error details that drive splitting and debugging. Cost to change: one method.
9. **Silence `httpx` and `httpcore` where the client lives.** `cli.main` does this today, so any other caller gets every URL logged at INFO, and Dagster (unit 2.7) won't go through `cli.main`. Alternative: leave it to each entry point, which fails unsafe. Cost to change: two lines.
10. **The real run compares two cold backfills once.** It costs tens of minutes and no code, and it is the only pre-launch check that can see a lost ordinary transfer before unit 2.8 exists. Alternative: rely on unit 2.8's `sampled_balances` alone, which comes later and samples 50 wallets. Cost to change: drop one runbook step.

## Open questions

### Resolved during planning

- **Does `dev` already protect the URL?** Partly. `Chain` repr, retry logging, labels and whole-URL scrubbing are already right, and the existing test covers them. B1 lists what is missing, each reproduced offline with a fake key.
- **Does the provider include `blockTimestamp`?** Yes on every range checked, so `decode_rpc_log` works unchanged. If a backend omits it, the `KeyError` stops the run before anything is stored.
- **Does Base use standard mints and burns?** The first Transfer is a mint from the zero address, and supply moved from 0 to exactly that amount in that block. The real run proves the rest.
- **Does `uv run --env-file` override a variable set in the shell?** No, the shell wins, so the scratch database in step 8 is safe. Tested with fake values.

### Deferred

- **Whether every cold 10,000-block read stays fast.** The sample is small. Retries cover a slow read, and a run that gives up resumes from its cursor. If failures don't follow window size, lowering the value may not help.
- **Actual row count and backfill time.** Roughly 100,000 rows and tens of minutes, from sampled density and latency. The sustained call rate is also unmeasured. The real run settles these.
- **Whether unit 1.3 and 1.4 plans match the Interfaces below.** Neither was written when this was.

## Implementation units

**Dependency for both units:** `dev` at or after PR #5, which adds mypy to `make check`. New and changed functions in `pipeline/ousd` need full type hints, and test bodies are type-checked even when unannotated. Tests never use the network, `.env` or `data/ousd.duckdb`. Pass an explicit `env` to `load_chains`, use `monkeypatch.delenv` where the CLI reads `os.environ`, and set `OUSD_DB_PATH` to a `tmp_path` in every test that goes through `cli.main`.

- [ ] **Unit B1 (foundation): Keep keyed URLs out of logs and errors, and fail clearly when a key is missing**

**Goal:** no RPC client path can write a keyed URL, or the key alone, to a log line, exception or repr. A chain with no key stops the run with a message naming the variable. Unit 1.3 reuses all of this.

**Requirements:** Architecture "Security and secrets", R1.

**Dependencies:** PR #5. Land before B2 and before unit 1.3's client.

**Files:**
- Modify: `pipeline/ousd/http.py`, `pipeline/ousd/sources.py`, `pipeline/ousd/chains.py`, `pipeline/ousd/cli.py`
- Create: `tests/test_secrets.py`

**Schema or migration:** none.

**Approach:**

| Gap on `dev`, reproduced with a fake key | Fix |
|---|---|
| A JSON-RPC error on HTTP 200 echoing the URL or key reaches `RpcError` unscrubbed, in `RpcClient._call` | Pass the message through `scrub` |
| The same for `RuntimeError(f"Blockscout error ...")` in `BlockscoutClient._page`, whose URL is also configurable | Pass it through `scrub` |
| A 4xx body or transport error echoing the bare key survives `_scrub`, which only matches the URL, the host and the path with its slash | Extend the method as in decision 8 |
| `_snippet` cuts the body at 200 bytes before scrubbing, so a key across the cut leaves part of itself | Decode and scrub the whole body, then cut to 200 characters |
| Any caller other than `cli.main` logs every request URL through the `httpx` logger | Set `httpx` and `httpcore` to WARNING at import of `http.py`. Remove the line and comment from `cli.main` |
| `httpx.InvalidURL` isn't a `TransportError`, so it escapes raw, and its text can quote part of the URL | Catch it in `request_json` and raise `HttpError` with the label and "invalid URL" after the `except` block, so `__context__` stays empty |
| `httpx.DecodingError` isn't a `TransportError` either, so it escapes raw with the keyed URL on its `.request` | Catch `httpx.RequestError` instead of `TransportError` in `request_json`, so it is retried like other request failures |

- `PoliteClient._scrub` becomes the public method `PoliteClient.scrub(text, url)`. It keeps the `<label>` replacement and replaces in a single pass, because a host label can equal the client label (`base-rpc`), and a second pass would rewrite the inserted text. With no qualifying part, as for a blank URL, it returns the text unchanged.
- `chains.py` adds `KEYED_RPC_ENV`, mapping `base` to `BASE_RPC_URL` and `solana` to `SOLANA_RPC_URL`, and `missing_rpc_keys(names, env)`, which returns the variables that the named chains need and that are unset, empty or whitespace.
- `cli.main` calls it after the `--at-block` check and before `Store(...)`, and on any result calls `parser.error`, naming the variables and suggesting `--chain`. The database file is therefore not created.
- Keep the existing `load_chains` signature and `PoliteClient` keyword arguments.

**Patterns to follow:** `test_a_failure_never_reveals_the_url` in `tests/test_http.py`, and the injected `transport` and `sleep` used there.

**Test scenarios** (`tests/test_secrets.py`). Use a fake key and parametrize URLs with it in the path, in a query value and as a password. "Clean" means the key is absent from `str(exc)`, `repr(exc)`, `exc.args`, `traceback.format_exception(exc)`, `caplog.text` captured at DEBUG on the root logger, and the same checks on `__cause__` and `__context__`. No exception reaching the caller may carry a `.request` attribute.
- Error path: HTTP 500 until attempts run out -> `HttpError` names the label and is clean, including the retry warnings.
- Error path: HTTP 403 whose body contains the bare key and the word "archive" -> keeps "archive", clean.
- Error path: HTTP 403 whose body holds the key, and separately the full URL, across byte 200 -> no prefix of the key of 8 or more characters remains.
- Error path: HTTP 200 JSON-RPC error containing the full URL, and one containing the bare key -> `RpcError` keeps the method name, clean.
- Error path: `httpx.ConnectError` whose message holds the bare key -> clean after retries.
- Error path: HTTP 200 that isn't JSON -> clean after retries.
- Error path: a `gzip` content-encoding header over a body that isn't gzip -> `HttpError` after retries, clean.
- Error path: HTTP 302 whose `Location` and body echo the keyed URL -> clean, and no second URL is requested.
- Error path: Blockscout `status: "0"` whose body holds the bare key -> clean.
- Error path: URL with a non-numeric port -> `HttpError` saying "invalid URL", clean, no retry.
- Happy path: in a fresh subprocess that only imports `ousd.http`, the `httpx` and `httpcore` effective levels are WARNING or above. A subprocess is needed because `cli.main` sets the level for the whole process, which would hide this gap in a full suite run.
- Happy path: a successful request with the root logger at DEBUG -> key absent.
- Happy path: `repr` of a `Chain` holding the keyed URL, and of `RpcClient` -> key absent.
- Edge case: `scrub` leaves short parts (`/v2/`, `network=base`) and unrelated text unchanged. `scrub(text, "")` returns `text`.
- Edge case: label `base-rpc` on host `base-rpc.provider.invalid` -> the output contains `<base-rpc>` exactly, not nested.
- Integration: a result-cap error on a keyed URL still splits, so scrubbing doesn't break `TOO_MANY_RESULTS` matching.
- Integration: `cli.main(["--chain", "tempo", "sync"])` with a keyed `TEMPO_RPC_URL` and upstream 500s (patch `ousd.cli.PoliteClient` to inject the transport and a no-op sleep) -> raises, and the key is absent from the exception, `capsys` and `caplog`.
- Happy path: `missing_rpc_keys` lists a variable when it is unset, `""` or `"   "`, and not when it is set. A chain outside the mapping is never listed.
- Error path: with `cli.load_chains` patched to return a chain named `base` and no key, each of `["--chain", "base", "sync"]`, `["--chain", "base", "reconcile"]`, `["sync"]` and `["reconcile"]` exits 2, stderr names `BASE_RPC_URL`, and the `tmp_path` database doesn't exist. Repeat with `BASE_RPC_URL` set to `""`.
- Happy path: `["--chain", "tempo", "sync"]` with no Base key reaches `_sync` (patched).
- Edge case: `["reconcile", "--at-block", "5"]` still reports "exactly one --chain".

Existing tests in `tests/test_http.py`, `tests/test_sources.py` and `tests/test_cli.py` pass with no assertion changes.

**Verification:** `make check` passes with no `.env`. Every row of the table above has a test that fails on `dev` when `tests/test_secrets.py` runs on its own.

- [ ] **Unit B2: Add the Base chain entry**

**Goal:** `ousd --chain base sync` and `reconcile` run on Base.

**Requirements:** R1, R2, R3, supports R6.

**Dependencies:** B1.

**Files:**
- Modify: `pipeline/ousd/chains.py`, `README.md`
- Create: `tests/test_base.py`, `tests/fixtures/base_rpc_log.json`

**Schema or migration:** none.

**Approach:**
- Append to the `load_chains` tuple, after Ethereum: `name="base"`, `chain_id=8453`, `token="0xb2000000000000000000002feb517dfec7415344"` (lowercase, like the others), `rpc_url` from `BASE_RPC_URL` stripped with `""` when unset, `start_block=48_631_941`, `max_log_range=10_000`, `reorg_lookback=1_200`. No `blockscout_url`, and the default `rpc_interval`.
- Add a comment for each value giving its reason, as the Tempo entry does. Point to this plan's measurements or the build log. Update the module docstring, which says Base comes later.
- `README.md`: line 7 and the `make reconcile` paragraph say Base isn't built or checked, and "Every setting is optional and has a public default" stops being true. Change only those. Say Solana is still pending, so unit 1.3 can finish the sentences. Add one line: `make sync` and `make reconcile` need `BASE_RPC_URL`, and for public chains alone use `uv run --locked ousd --chain tempo --chain ethereum sync`, and the same for `reconcile`.

**Fixture** (`tests/fixtures/base_rpc_log.json`), the first Transfer, read from the chain:

```json
{
  "address": "0xb2000000000000000000002feb517dfec7415344",
  "topics": [
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x0000000000000000000000004c2c0f0bb2631b02ac9299c59690914ee7a200b8"
  ],
  "data": "0x00000000000000000000000000000000000000000000000000000000000f4240",
  "blockHash": "0xcfed93d34aebf673b5bbb7ce49d1df36870793ff311cadc1e7804d2586751dfa",
  "blockNumber": "0x30289bf",
  "blockTimestamp": "0x6a8f7061",
  "transactionHash": "0x1f43d5c43a2598da454322f72af81bd9d4d0bd108c498540dd3cc3a5c9354798",
  "transactionIndex": "0x9",
  "logIndex": "0xb",
  "removed": false
}
```

**Patterns to follow:** the Tempo and Ethereum entries in `chains.py`, `test_range_over_the_result_cap_is_split_until_it_fits` in `tests/test_sources.py`, and `FakeRpc` in `tests/conftest.py`. Don't edit `conftest.py`. For sync tests with `FakeRpc`, take the real Base entry and use `dataclasses.replace` to set `chain_id=1` (what `FakeRpc` serves) and a low `start_block`, keeping the real `reorg_lookback`. For sync tests over a mock transport, define a small JSON-RPC handler in `tests/test_base.py` serving `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber` with linked parent hashes, and `eth_getLogs`, with a tip above 20,000 so the real window gives several ranges.

**Test scenarios** (`tests/test_base.py`):

*Config*
- Happy path: `load_chains({"BASE_RPC_URL": url})["base"]` -> lowercase token, chain ID 8453, start block 48,631,941, window 10,000, lookback 1,200, no `blockscout_url`.
- Edge case: unset, `""` and `"   "` -> no exception, `rpc_url` is `""`. A value with surrounding whitespace is stripped.
- Edge case: `"base"` is in `REQUIRED_CHAINS` and `KEYED_RPC_ENV`, so the CLI's missing-key check covers it.
- Error path: `cli.main(["--chain", "base", "sync"])` through the real `load_chains`, with the variable unset and then empty -> exit 2 naming `BASE_RPC_URL`, no database file.

*Filter and decode*
- Happy path: decoding the fixture -> block 50,497,983, value 1,000,000, zero-address sender, the hash and timestamp as given.
- Error path: the fixture with another contract's address -> `ValueError`, since the OUSD ticker also belongs to Origin Dollar.
- Happy path: `sync_chain` over the mock handler -> each `eth_getLogs` body carries the lowercase Base address, the Transfer topic and hex bounds, and no span exceeds 10,000 blocks. Every block from start to tip is covered once.

*Provider responses, using the measured text*
- Happy path: "query exceeds max results 20000, retry with the range 53284845-53285190" on spans over 3 blocks -> `transfers(TOKEN, 1, 8)` returns 8 logs once each, in order.
- Error path: "exceed maximum block range: 50000" -> `RpcError` after one request, no split.
- Error path: "block range extends beyond current head block: requested 25000, head 24990" on the last range -> `RpcError`. Earlier ranges stay stored, the cursor is at the last good range, and a rerun completes with no duplicates.
- Error path: HTTP 500 with `-32701`, "broker: node error" -> retried, and then succeeds. When it never succeeds -> `HttpError`, cursor unchanged, and a rerun resumes.

*Reorg and idempotence, Base-shaped and simulated*
- Integration: finality lag 725, lookback 1,200 -> stored hashes cover every block above finalized.
- Edge case: `finalized` moves backward between two runs (725, then 505, then 725) -> no error, no rollback, and rows unchanged.
- Edge case: stalled finality, lag 2,000 -> stored hashes reach down to finalized plus one.
- Integration: a simulated reorg 700 blocks below the tip that changes one mint -> rollback, re-ingest, and `reconcile_chain` reports `matched`.
- Integration: rerun after a complete sync -> rows and cursor unchanged.
- Integration: `Store.rollback_to("base", start_block - 1)` with rows stored for another chain -> Base's rows and hashes are gone, the other chain's are unchanged, and the next sync starts at `start_block`.

**Verification:** `make check` passes with no `.env`. `ousd --chain base sync` without a key exits 2 with the message above.

## Real backfill and reconcile

Run by the coordinator after both units merge, from the primary checkout on `dev`, one sync at a time, because DuckDB allows one writer. Don't start it while another process holds `data/ousd.duckdb`. Don't pipe these through `tail`, because the exit status and the log both matter.

**Preconditions:** `BASE_RPC_URL` is set in the primary `.env`, and no process has the database open.

```sh
# 0. Back up the rows that took hours to fetch. Keep this until steps 1 to 8 pass.
cp -n data/ousd.duckdb data/ousd.pre-base.duckdb

# Steps 2 to 6 check one chain, so they are a partial run. Since unit 1.4 they print MATCH
# and then exit 3 (unchecked), because a full pass is all four chains. Exit 3 here is expected.
# A mismatch still exits 1.
# 1. Backfill. About 486 log calls and up to 1,200 header calls. Resumes if interrupted.
uv run --locked --env-file .env ousd -v --chain base sync

# 2. At the synced tip. Must print MATCH with a difference of 0 base units, then exit 3.
uv run --locked --env-file .env ousd --chain base reconcile

# 3. At the start block. Must print MATCH with every value 0, then exit 3.
uv run --locked --env-file .env ousd --chain base reconcile --at-block 48631941

# 4. Just before the first mint. Must print MATCH with every value 0, then exit 3.
uv run --locked --env-file .env ousd --chain base reconcile --at-block 50497982

# 5. At the first mint. Must print MATCH with totalSupply() 1.000000, then exit 3.
uv run --locked --env-file .env ousd --chain base reconcile --at-block 50497983

# 6. At a known point. Must print MATCH with totalSupply() 84,834,727.170000, then exit 3.
uv run --locked --env-file .env ousd --chain base reconcile --at-block 52483090

# 7. No address may have a negative balance. Must print 0. Catches many lost inflows.
uv run --locked python -c "
import duckdb
rows = duckdb.connect('data/ousd.duckdb', read_only=True).execute('''
    SELECT address, sum(delta)::VARCHAR FROM (
        SELECT to_address AS address, value AS delta FROM transfers WHERE chain = 'base'
        UNION ALL
        SELECT from_address, -value FROM transfers WHERE chain = 'base'
    )
    WHERE address <> '0x0000000000000000000000000000000000000000'
    GROUP BY address HAVING sum(delta) < 0
''').fetchall()
print(len(rows), 'addresses with a negative balance', rows[:20])
"

# 8. A second cold backfill into a scratch file, compared row for row. Tens of minutes.
#    The shell's value beats --env-file, so this never writes to data/ousd.duckdb.
OUSD_DB_PATH=data/base-check.duckdb uv run --locked --env-file .env ousd -v --chain base sync
test -f data/base-check.duckdb
uv run --locked python -c "
import duckdb
db = duckdb.connect('data/ousd.duckdb', read_only=True)
db.execute(\"ATTACH 'data/base-check.duckdb' AS other (READ_ONLY)\")
limit = db.execute('''
    SELECT least(a.synced_through, b.synced_through) - 1200
    FROM main.sync_state a, other.sync_state b
    WHERE a.chain = 'base' AND b.chain = 'base'
''').fetchone()[0]
for x, y in (('main', 'other'), ('other', 'main')):
    count = db.execute(f'''SELECT count(*) FROM (
        SELECT * FROM {x}.transfers WHERE chain = 'base' AND block_number <= {limit}
        EXCEPT
        SELECT * FROM {y}.transfers WHERE chain = 'base' AND block_number <= {limit}
    )''').fetchone()[0]
    print(f'{count} rows in {x} missing from {y}, through block {limit}')
"
rm data/base-check.duckdb
```

The queries in steps 7 and 8 and `rollback_to` below were tested on throwaway databases, and each caught a deliberately dropped row. Nothing here has run against real Base rows. Step 8 can't catch an omission the backend repeats, which is why `sampled_balances` must also pass later.

| Result | Action |
|---|---|
| Step 1 fails with HTTP 500 or "gave up after" | Rerun. It resumes. If it repeats on the same range, lower `max_log_range` in a one-line PR |
| Step 1 fails with "vanished", "changed during sync", "does not extend", "behind every stored block" or "beyond current head" | Rerun. The tip moved or a backend lagged |
| Step 1 prints "reorg repaired" | Continue. A lagging backend can cause this as well as a real reorg, so don't record it as a real one without checking |
| Step 1 fails with "deeper than the lookback", `StoreConflict`, `KeyError` or anything else | Stop and report. **Never follow advice to use a fresh database on the shared file**, because it holds Tempo and Ethereum |
| Step 2 `MISMATCH` | Rerun steps 1 and 2 once, because a lagging backend can miss a log near the tip. If it persists, **stop and publish nothing**, report it, and don't adjust the data or the check. If the rerun heals it, record that and treat it as evidence that this provider omits rows |
| Step 2 prints MATCH, then fails on Bridge | Rerun step 2. A Bridge error isn't a reconciliation failure |
| Bridge lines in step 2's output | Ignore them. With `--chain base` the comparison is `PARTIAL` and only unit 1.4 acts on it |
| Steps 3 to 6 `MISMATCH` | Stop and report. It means history is wrong, and a rerun won't fix it |
| Step 7 prints above 0, or step 8 prints above 0 | Stop and publish nothing. A log read was incomplete, and reconciliation can't see it |

**Resetting Base only,** if a report leads to the maintainer's approval. It removes only Base's rows and hashes, and the next sync starts again at 48,631,941:

```sh
uv run --locked python -c "from ousd.store import Store; Store('data/ousd.duckdb').rollback_to('base', 48631940)"
```

Record in `docs/build-log.md`: transfer count, reconciled block, minted, burned, `totalSupply()`, difference, backfill time, retry counts, the slowest range, and the results of steps 7 and 8. Write counts and block numbers, and don't paste log lines. Base stays out of anything published until steps 2 to 8 pass and the blocking checks from units 1.4 and 2.8 pass on Base.

## What needs a real key

| Claim | Proven by |
|---|---|
| Keyed URLs can't reach logs, errors or repr | Tests, with a fake key |
| Clear failure when the key is missing, empty or blank | Tests |
| Limit, retry, reorg and idempotence behaviour | Tests, with simulated responses and reorgs, not real ones |
| Start block, caps, finality and token identity | Measured above with the real key, already done |
| Base reconciles to the base unit, and two backfills agree | **Only the real run** |

## Interfaces

Plans for units 1.3 and 1.4 weren't available when this was written, so these need checking when the plans are read together.

### Assumes from 1.1, merged and read on `origin/dev`

`Chain`, `load_chains(env)`, `RpcClient(http, url)`, `PoliteClient(label=...)`, `sync_chain(chain, rpc, store, history=None)`, `reconcile_chain(chain, rpc, store, at_block)`, `Store`, including `rollback_to`, `REQUIRED_CHAINS` (already includes `base` and `solana`) and the top-level `--chain` option. `runners.py`, a `kind` column, `reconcile_at` and `PENDING_CHAINS` don't exist on `dev`, and this plan doesn't use them.

### Exposes from this plan (1.2)

- `PoliteClient.scrub(text, url)`.
- `KEYED_RPC_ENV` and `missing_rpc_keys(names, env)`.
- `load_chains()["base"]`, with `start_block` 48,631,941, `max_log_range` 10,000 and `reorg_lookback` 1,200.
- `tests/test_secrets.py`, the shared key-safety test file.

### For 1.3 (Solana)

- **Uses:** Solana's RPC client goes through `PoliteClient`, which brings retries, logging and exception safety, and passes provider error text through `PoliteClient.scrub`.
- **Uses:** `KEYED_RPC_ENV` already maps `solana`. 1.3 keeps a separate `SolanaChain` and `load_solana`, and `cli.main` counts Solana as selected, so the CLI check applies to Solana through 1.3's own wiring and 1.3 adds no `solana` entry to `load_chains`.
- **Order:** B1 lands before 1.3's client. Only B1 changes `http.py`.
- **Assumes from 1.3:** it leaves the Base entry and existing `Chain` fields as they are, strips and treats blank `SOLANA_RPC_URL` the same way, extends `tests/test_secrets.py` rather than duplicating it, and finishes the README sentences left open by B2.

### For 1.4 (full reconciliation)

- **Uses:** `load_chains()["base"]`, with `reconcile_chain` and `RpcClient.total_supply` unchanged. `ousd reconcile` exits 2 when a selected chain has no key.
- **Uses:** `RpcClient._call` scrubs errors, so anything added there inherits that. An independent client must use `scrub`.
- **Assumes from 1.4:** after B2 merges and before the backfill, `ousd reconcile` with no `--chain` raises `RuntimeError` ("nothing synced yet") at Base after printing Tempo and Ethereum. This is correct and loud, and 1.4 shouldn't soften it into a pass.
- **Assumes from 1.4:** the rerun rule in the real-run table covers only this first run. 1.4 decides whether its blocking check reruns once when a lagging backend causes a tip mismatch.

### Later units

- Unit 2.8 owns `sampled_balances` and `balance_of`, the check that can see a lost ordinary transfer in the ongoing pipeline, and it must run on Base rows. It also adds `EXPECTED_CHAINS` to `chains.py` and commands to `cli.py`. Its manifest must not include `rpc_url`.
- Unit 2.7 (Dagster) builds clients through `PoliteClient` and checks `missing_rpc_keys`, with no `Chain.rpc_url` in run config or logs. Its logging config must not lower the `httpx` or `httpcore` levels.

## Path overlaps

| Path | This plan | Change | Likely also | Conflict |
|---|---|---|---|---|
| `pipeline/ousd/chains.py` | B1, B2 | B1 adds `KEYED_RPC_ENV`, `missing_rpc_keys`. B2 appends the Base entry and edits the docstring | 1.3, if Solana goes in `load_chains`. 2.8 (`EXPECTED_CHAINS`) | **Moderate.** Same tuple as 1.3. Land B1, then B2, then rebase 1.3 |
| `pipeline/ousd/cli.py` | B1 | Adds the missing-key check in `main`, removes the `httpx` line. `_sync`, `_rpc_for` and `_reconcile` untouched | 1.3 (dispatch), 1.4 (`_reconcile`), 2.8 (commands) | **Moderate.** Same function as 1.3's dispatch, different lines |
| `pipeline/ousd/sources.py` | B1 | Scrubs two error messages. No signature changes | 2.8 (`balance_of`) | Low |
| `pipeline/ousd/http.py` | B1 | Public `scrub`, scrub before cut, wider exception catch, logger levels | 1.3 uses it and shouldn't change it | Low if the order above holds |
| `pipeline/ousd/store.py` | **No change** | None | 1.3, 1.4 or 2.8 if they add a table | None |
| `.env.example` | **No change** | PR #5 already added the name | None | None |
| `README.md` | B2 | Three sentences and one new line | 1.3, 1.4 | Low |
| `tests/test_secrets.py`, `tests/test_base.py`, `tests/fixtures/base_rpc_log.json` | New | Created here | 1.3 extends `test_secrets.py` | Low |

## Changes the binding docs need

This plan doesn't edit them, so the coordinator applies these. Applied in the Phase 1 binding-docs change.

- `docs/implementation-plan.md`, row 1.2: paths should add `pipeline/ousd/http.py`, `pipeline/ousd/cli.py` and `README.md`.
- `docs/architecture.md`, Security and secrets: "Never log full RPC URLs" should read "Never log or raise an RPC URL or any part of it", because a bare key leaks just the same.

## Risks

| Risk | Mitigation |
|---|---|
| A backend omits ordinary transfers from an old range, which reconciliation can't see | Steps 7 and 8 now, unit 2.8's `sampled_balances` later and blocking. A repeatable omission could pass step 8, and that risk stays until `sampled_balances` passes |
| An unqualified `make sync` starts the first Base backfill alongside other work, or ages Ethereum past its roughly 100 block public state window before `make reconcile` | The real run uses `--chain base`. If an unqualified run happens, re-sync Ethereum before reconciling. DuckDB's single writer makes a collision fail loudly |
| Contributors without a Base key find `make sync` and `make reconcile` exit 2 | Intended by decision 6. The error names the variable and the README gives the direct command |
| Cold reads worsen and a range keeps failing | Retries, resume and a one-line change to `max_log_range` |
| A lagging backend omits a log near the tip | `sync_chain` re-reads the newest blocks each run, and step 2's rerun covers the first run |
| The provider echoes a re-cased or encoded key, or a later provider uses a key under 8 characters | Accepted. The scrub matches literal parts of 8 or more characters. Today's key is 64, and no response seen transforms it. Providers that use an auth header aren't covered |
| The real run shows supply moving without a Transfer | Stop and publish nothing. That finding would change this plan |
| A deep real reorg isn't what was tested | Reorgs are simulated only, as the architecture requires us to state |

## Sources

- `docs/PRD.md` (R1, R2, R3, R6), `docs/architecture.md`, `docs/implementation-plan.md`, `docs/build-log.md`, `docs/plans/2026-11-03-001-insight-models-plan.md`.
- Code on `origin/dev` at PR #5: `pipeline/ousd/`, `tests/`. No `docs/solutions/` exists in this repo.
- Read-only JSON-RPC probes against `BASE_RPC_URL` on 2026-11-04 UTC, and offline tests with a fake key against `pipeline/ousd/http.py` and `sources.py`.
