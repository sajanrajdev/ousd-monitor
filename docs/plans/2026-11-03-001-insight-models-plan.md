# Insight models plan: units 2.2 to 2.8

**Status:** ready to build.
**Date:** 2026-11-03
**Inputs:** `docs/brainstorms/2026-11-03-adoption-metrics-requirements.md` (the why and the numbers), PRD section 7 (definitions), `docs/architecture.md` (binding stack).

## How to use this

Build units in the order below. Each lists exact paths, the contract and its tests. All SQL here was run as a real dbt project against a copy of the data on 2026-11-04 and passed, including with the placed window changed through a variable. The Python in units 2.7 and 2.8 was not run; treat its signatures as the contract.

Base all work on `dev`, which holds Phase 1. Follow `AGENTS.md`: Conventional Commits, no network in tests, `make check` must pass.

## Dependency order

```
P. Prerequisites from Phase 1 (below)
2.2 dbt project and staging
2.3 labels
  |-- 2.4 mart_supply_journey
  |-- 2.5 mart_activity_waterfall and mart_activity_kpis
       |-- 2.6 mart_chain_roles and mart_reconciliation
            |-- 2.8 checks, publish step and dataset schema
                 |-- 2.7 Dagster assets, schedule and blocking checks
```

2.4 and 2.5 can run in parallel. **2.8 comes before 2.7** on purpose, so that Dagster wraps real functions instead of stubs. That is the only change from the numbering in `docs/implementation-plan.md`.

### Prerequisites

| Need | Status | Effect if missing |
|---|---|---|
| Ethereum backfill finished and reconciled | Running | Ethereum figures stay partial and unreconciled |
| Unit 1.2 Base source, `BASE_RPC_URL` | Needs the maintainer's key | Models build, publish stays blocked |
| Unit 1.3 Solana source, `SOLANA_RPC_URL` | Needs the maintainer's key | Same |
| Unit 1.4 Full Bridge comparison | Not started; unit 2.8 adds the persisted table it needs | Cross-chain check can't pass |

**Solana contract, so the models work unchanged:** unit 1.3 must write to `transfers` with mints from and burns to `ousd.decode.ZERO_ADDRESS`, `tx_hash` set to the signature, `log_index` unique within the block and ordered within the transaction, and `from_address`/`to_address` set to the **owner wallet**, not the token account. Otherwise wallet balances and placed supply will be wrong on Solana. Base58 addresses keep their case; EVM addresses stay lowercase.

**Build everything with Tempo and Ethereum first.** Nothing here needs Base or Solana to develop.

## Shared decisions

- **Two database files.** Raw stays in `data/ousd.duckdb`, which dbt attaches read-only. dbt writes only to `data/marts.duckdb`. This enforces "raw is immutable" and means dbt can never damage ingestion. DuckDB allows one writer per file, so nothing may hold `ousd.duckdb` open for writing while dbt runs.
- **Amounts are `HUGEINT` base units** in every model. Ratios are integer basis points from integer division, and floats never appear. JSON carries amounts as strings.
- **Days are UTC.** A chain's models stop at its last complete day: the day before its newest transfer.
- **Thresholds are dbt variables** in `dbt_project.yml`. Publish copies them into the manifest.
- **`dbt` commands run from the repo root** with `--project-dir dbt --profiles-dir dbt`, so relative paths in the profile and in `labels_path` resolve from there.

## Unit 2.2: dbt project and staging

**Delivers:** a dbt project that reads raw tables read-only and passes `dbt build`.

**Paths**
- Create `dbt/dbt_project.yml`, `dbt/profiles.yml`, `dbt/models/staging/_sources.yml`, `dbt/models/staging/_staging.yml`, `dbt/models/staging/stg_transfers.sql`, `dbt/models/staging/stg_sync_coverage.sql`.
- Modify `pyproject.toml`: add `dbt-core>=1.8` and `dbt-duckdb>=1.8` to dependencies, and `sqlfluff>=3` to the dev group. Run `uv lock`. Tested with dbt-core 1.12.6 and dbt-duckdb 1.11.1.
- Modify `Makefile` and `.gitignore`, as below. Create `tests/dbt_helpers.py`, `tests/test_dbt_staging.py`.

**Contract**

`dbt/dbt_project.yml`

```yaml
name: ousd_monitor
version: "1.0"
profile: ousd_monitor
model-paths: ["models"]
test-paths: ["tests"]
models:
  ousd_monitor:
    staging: {+materialized: view}
    intermediate: {+materialized: table}
    marts: {+materialized: table}
vars:
  labels_path: labels/labels.csv
  zero_address: "0x0000000000000000000000000000000000000000"
  tempo_fee_manager: "0xfeec000000000000000000000000000000000000"
  placed_days: 14
  placed_min_base_units: 1000000000000
  large_transfer_base_units: 1000000000000
  active_dust_base_units: 1000000
  active_secondary_base_units: 100000000
  clean_tx_min_base_units: 1000000
```

`dbt/profiles.yml`

```yaml
ousd_monitor:
  target: dev
  outputs:
    dev:
      type: duckdb
      path: "{{ env_var('OUSD_MARTS_DB_PATH', 'data/marts.duckdb') }}"
      threads: 2
      attach:
        - path: "{{ env_var('OUSD_DB_PATH', 'data/ousd.duckdb') }}"
          alias: raw
          read_only: true
```

`dbt/models/staging/_sources.yml`

```yaml
version: 2
sources:
  - name: raw
    database: raw
    schema: main
    tables:
      - name: transfers
      - name: sync_state
      - name: reconciliations
      - name: bridge_comparisons
```

`dbt/models/staging/stg_transfers.sql`

```sql
select
    chain,
    block_number,
    log_index,
    block_hash,
    block_timestamp,
    cast(to_timestamp(block_timestamp) at time zone 'UTC' as date) as day_utc,
    tx_hash,
    from_address,
    to_address,
    cast(value as hugeint) as value
from {{ source('raw', 'transfers') }}
```

`dbt/models/staging/stg_sync_coverage.sql`

```sql
select
    s.chain,
    s.synced_through,
    max(t.block_timestamp) as last_transfer_timestamp,
    cast(to_timestamp(max(t.block_timestamp)) at time zone 'UTC' as date) - 1 as last_complete_day
from {{ source('raw', 'sync_state') }} as s
inner join {{ ref('stg_transfers') }} as t on t.chain = s.chain
group by s.chain, s.synced_through
```

`stg_labels` is in unit 2.3. `bridge_comparisons` is created by unit 1.4, with a nullable `run_id` added. Until it lands, add this `CREATE TABLE IF NOT EXISTS` to `store.py` in this unit, since the source must exist for `mart_reconciliation`. Unit 1.4's `ALTER TABLE ... ADD COLUMN IF NOT EXISTS run_id` upgrades it whichever lands first.

```sql
CREATE TABLE IF NOT EXISTS bridge_comparisons (
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    chains_included VARCHAR NOT NULL,
    chains_missing VARCHAR NOT NULL,
    chains_total HUGEINT NOT NULL,
    bridge_total HUGEINT NOT NULL,
    tolerance HUGEINT NOT NULL,
    passed BOOLEAN NOT NULL
);
```

`_staging.yml` declares column tests:
- `stg_transfers`: `not_null` on `chain`, `block_number`, `log_index`, `block_timestamp`, `day_utc`, `tx_hash`, `from_address`, `to_address`, `value`. **Not** on `block_hash`, because Blockscout rows have none (all 27,919 Ethereum rows today). `accepted_values` on `chain`: `tempo`, `ethereum`, `base`, `solana`.
- `stg_sync_coverage`: `unique` and `not_null` on `chain`.

Singular tests, in `dbt/tests/`:

`dbt/tests/assert_unique_transfer_key.sql`

```sql
select chain, block_number, log_index, count(*) as n
from {{ ref('stg_transfers') }}
group by chain, block_number, log_index
having count(*) > 1
```

**Makefile:** add `models` running `uv run --locked dbt build --project-dir dbt --profiles-dir dbt`. Extend `lint` with `uv run --locked sqlfluff lint dbt/models dbt/tests --dialect duckdb --templater jinja`. If sqlfluff can't parse the Jinja in a model, add an exclusion in `.sqlfluff` rather than rewriting the SQL. This lint setup is untested.

**.gitignore:** `target/` and `logs/` are already covered. Add `dbt/.user.yml`.

**Test helper:** `tests/dbt_helpers.py`

```python
def build_marts(
    tmp_path, transfers, labels, sync_state, reconciliations=(), select=None, dbt_vars=None
) -> duckdb.DuckDBPyConnection:
    """Write a raw DuckDB and a labels CSV under tmp_path, run dbt build through dbtRunner,
    and return a read-only connection to the marts file. Raises if dbt fails unless told not to."""
```

It uses `ousd.store.Store` to create the raw file, sets `OUSD_DB_PATH` and `OUSD_MARTS_DB_PATH` for the run, and passes `labels_path` through `--vars`. Use `from dbt.cli.main import dbtRunner`. Add a `failed_tests(result)` helper so tests can assert that a specific singular test failed. Keep model tests in one module-scoped fixture where possible, since each dbt run takes seconds.

**Test scenarios (pytest)**
- A mint and a transfer on `tempo` appear in `stg_transfers` with `value` as `HUGEINT`, and the correct UTC `day_utc` for a timestamp at 23:59:59 and 00:00:00.
- A value above 2^64 survives unchanged, to prove no float or `BIGINT` path exists.
- `stg_sync_coverage`: newest transfer on day D gives `last_complete_day` of D minus 1.
- Null `block_hash` passes all tests.
- A build leaves the raw file byte-identical. Hash it before and after.
- A new chain name not in the accepted list fails `dbt build`.

## Unit 2.3: labels

**Delivers:** the versioned labels file and its staging model.

**Paths:** create `labels/labels.csv`, `labels/README.md`, `dbt/models/staging/stg_labels.sql`, `tests/test_labels.py`. Extend `_staging.yml`.

**Contract:** CSV with columns `chain,address,entity,category,source_url,confidence,date_checked`.

- `entity` is empty for unnamed clusters, which still need a `source_url`, pointing at the brainstorm section that defines the rule.
- `category`: `issuer`, `issuer_route`, `system`, `dex`, `lending`, `exchange`.
- `confidence`: `high`, `medium`.
- One row per chain and address. EVM addresses lowercase. **A wallet absent from this file counts as unlabeled**, which is the safe default.

`dbt/models/staging/stg_labels.sql`

```sql
select
    chain,
    address,
    nullif(entity, '') as entity,
    category,
    source_url,
    confidence,
    cast(date_checked as date) as date_checked
from read_csv('{{ var("labels_path") }}', header = true, all_varchar = true)
```

**Initial rows.** `date_checked` is 2026-11-03 for all. Use the source URLs in the brainstorm's labels table. For unnamed `issuer_route` rows use `docs/brainstorms/2026-11-03-adoption-metrics-requirements.md`, except where noted.

| chain | address | entity | category | confidence |
|---|---|---|---|---|
| tempo, ethereum, base | `0x4c2c0f0bb2631b02ac9299c59690914ee7a200b8` | Bridge | issuer | high |
| tempo, ethereum | `0x4508a7021dfb7a1afe5ff60169c1778c303389fb` | | issuer_route | medium |
| tempo, ethereum | `0x8458377a025da58e9cb547c979d5002c822a05cb` | | issuer_route | medium |
| tempo, ethereum | `0x19810813f2e46cf01e7c543f6d8c3ecc8ea2001e` | | issuer_route | medium |
| tempo | `0x334cc71f818324f3932ab9d41285450373b84cdc` | | issuer_route | medium |
| tempo | `0x5176dfcab18ff5519bc1cfa4c6ef2d8008371d5f` | | issuer_route | medium |
| ethereum | `0x0198f9d5c8e8ef8869d70d387d3efa997f727464` | | issuer_route | medium |
| ethereum | `0x1767c61c9ec15126de4eb02cd9a91474584a1873` | | issuer_route | medium; source is its Etherscan page |
| tempo | `0xfeec000000000000000000000000000000000000` | Tempo Fee Manager | system | high |
| tempo | `0xb10c000000000000000000000000000000000000` | Tempo ReceivePolicyGuard | system | high |
| tempo | `0xdec0000000000000000000000000000000000000` | Tempo Stablecoin DEX | dex | high |
| tempo | `0x33620f62c5b9b2086dd6b62f4a297a9f30347029` | Uniswap v4 PoolManager | dex | high |
| ethereum | `0x000000000004444c5dc75cb358380d2e3de08a90` | Uniswap v4 PoolManager | dex | high |
| base | `0x498581ff718922c3f8e6a244956af099b2652b2b` | Uniswap v4 PoolManager | dex | high |
| tempo | `0x0d136e26b4d9e4836fc5cb202baeb49cb6f5df48` | Sentora OUSD Main | lending | high |
| tempo | `0xb86b3ccce82f6cb767c45afb9fb032ae5fde3592` | Tempo Earn | lending | medium |
| ethereum | `0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43` | Coinbase | exchange | high |

**Do not add** Wintermute, Coinbase Prime, the Coinbase custody addresses or any other wallet that lacks a source tying the name to the address. See the brainstorm.

**When Base and Solana land, in the same change as units 2.3, 2.4 and 2.5:**
- Add the Base and Solana redemption route with rows found by rule: wallets on the fixed path from the hub into burns.
- Add Solana's mint recipient as an `issuer` row only if a source names the address. If not, use `issuer_route`, so its balance is still inventory.
- Add Orca's pool, with a source.

`labels/README.md` states the rule: a published source must tie the name to the address, matching behavior is not enough, and a label change is a reviewed change.

**Test scenarios (pytest, `tests/test_labels.py`, reads the real file)**
- Each `(chain, address)` is unique.
- Every row has a `source_url`, a `category` in the list, a `confidence` in the list and a valid date.
- EVM addresses match `^0x[0-9a-f]{40}$`. Solana addresses are never lowercased.
- A named `entity` has an `http` source. A local brainstorm path is only allowed when `entity` is empty.
- Each chain has at least one `issuer` row.

**dbt tests:** `accepted_values` on `category` and `confidence`, `not_null` on `chain` and `address`, plus a singular test that `(chain, address)` is unique.

## Unit 2.4: mart_supply_journey

**Delivers:** view A's data: per chain and day, how much is issuer inventory, placed, in venues and free-floating.

**Paths:** create the three intermediate models and the mart below, plus `dbt/models/intermediate/_intermediate.yml`, `dbt/models/marts/_marts.yml`, `tests/test_supply_journey.py`, and two singular tests.

**Contract**

`dbt/models/intermediate/int_wallet_events.sql`

```sql
with legs as (
    select chain, to_address as address, block_number, log_index, 1 as side, day_utc, value as delta
    from {{ ref('stg_transfers') }}
    union all
    select chain, from_address as address, block_number, log_index, 0 as side, day_utc, -value as delta
    from {{ ref('stg_transfers') }}
)

select
    chain,
    address,
    block_number,
    log_index,
    side,
    day_utc,
    delta,
    cast(
        sum(delta) over (
            partition by chain, address
            order by block_number, log_index, side
            rows unbounded preceding
        ) as hugeint
    ) as running_balance
from legs
where address <> '{{ var("zero_address") }}'
```

`dbt/models/intermediate/int_wallet_days.sql`

```sql
with day_bounds as (
    select
        chain,
        address,
        day_utc,
        arg_max(running_balance, (block_number, log_index, side)) as close_balance,
        min(running_balance) as day_min
    from {{ ref('int_wallet_events') }}
    group by chain, address, day_utc
),

wallets as (
    select chain, address, min(day_utc) as first_day
    from day_bounds
    group by chain, address
),

chain_days as (
    select
        c.chain,
        cast(unnest(generate_series(min(b.day_utc), c.last_complete_day, interval 1 day)) as date) as day_utc
    from day_bounds as b
    inner join {{ ref('stg_sync_coverage') }} as c on c.chain = b.chain
    group by c.chain, c.last_complete_day
),

spine as (
    select w.chain, w.address, d.day_utc
    from wallets as w
    inner join chain_days as d on d.chain = w.chain and d.day_utc >= w.first_day
),

filled as (
    select
        s.chain,
        s.address,
        s.day_utc,
        b.day_min,
        last_value(b.close_balance ignore nulls) over (
            partition by s.chain, s.address
            order by s.day_utc
            rows between unbounded preceding and current row
        ) as close_balance
    from spine as s
    left join day_bounds as b
        on b.chain = s.chain and b.address = s.address and b.day_utc = s.day_utc
)

select
    chain,
    address,
    day_utc,
    close_balance,
    coalesce(day_min, close_balance) as day_min
from filled
```

`dbt/models/intermediate/int_wallet_placed.sql`

```sql
{% set n = var("placed_days") %}

select
    d.chain,
    d.address,
    d.day_utc,
    d.close_balance,
    l.category,
    case
        when count(*) over w_full = {{ n + 1 }} then
            least(first_value(d.close_balance) over w_full, min(d.day_min) over w_after)
    end as still_value
from {{ ref('int_wallet_days') }} as d
left join {{ ref('stg_labels') }} as l on l.chain = d.chain and l.address = d.address
window
    w_full as (partition by d.chain, d.address order by d.day_utc rows between {{ n }} preceding and current row),
    w_after as (partition by d.chain, d.address order by d.day_utc rows between {{ n - 1 }} preceding and current row)
```

`dbt/models/marts/mart_supply_journey.sql`

```sql
{% set min_value = var("placed_min_base_units") %}

with wallets as (
    select
        chain,
        day_utc,
        address,
        close_balance,
        category,
        case
            when category is null and still_value >= {{ min_value }} then still_value
            else 0
        end as placed_part
    from {{ ref('int_wallet_placed') }}
),

ranked as (
    select
        *,
        row_number() over (partition by chain, day_utc order by close_balance desc, address) as balance_rank
    from wallets
    where close_balance > 0
)

select
    chain,
    day_utc,
    cast(sum(close_balance) as hugeint) as total_supply,
    cast(coalesce(sum(close_balance) filter (where category in ('issuer', 'issuer_route')), 0) as hugeint) as issuer_inventory,
    cast(sum(placed_part) as hugeint) as placed_supply,
    cast(coalesce(sum(close_balance) filter (where category = 'dex'), 0) as hugeint) as venue_dex,
    cast(coalesce(sum(close_balance) filter (where category = 'lending'), 0) as hugeint) as venue_lending,
    cast(coalesce(sum(close_balance) filter (where category = 'exchange'), 0) as hugeint) as venue_exchange,
    cast(coalesce(sum(close_balance - placed_part) filter (where category is null or category = 'system'), 0) as hugeint) as free_floating,
    count(*) filter (where placed_part > 0) as placed_wallets,
    count(*) as holders,
    count(*) filter (where close_balance >= {{ min_value }}) as holders_over_1m,
    cast(sum(close_balance) filter (where balance_rank <= 10) as hugeint) as top10_value
from ranked
group by chain, day_utc
```

`dbt/tests/assert_journey_adds_up.sql`

```sql
select chain, day_utc
from {{ ref('mart_supply_journey') }}
where total_supply <> issuer_inventory + placed_supply + venue_dex + venue_lending + venue_exchange + free_floating
```

`dbt/tests/assert_journey_matches_events.sql`

```sql
with events as (
    select
        chain,
        day_utc,
        sum(sum(case when from_address = '{{ var("zero_address") }}' then value else 0 end)
            - sum(case when to_address = '{{ var("zero_address") }}' then value else 0 end))
            over (partition by chain order by day_utc rows unbounded preceding) as supply
    from {{ ref('stg_transfers') }}
    group by chain, day_utc
)

select j.chain, j.day_utc
from {{ ref('mart_supply_journey') }} as j
inner join events as e on e.chain = j.chain and e.day_utc = j.day_utc
where j.total_supply <> e.supply
```

`dbt/tests/assert_no_negative_balances.sql`

```sql
select chain, address, min(running_balance) as lowest
from {{ ref('int_wallet_events') }}
group by chain, address
having min(running_balance) < 0
```

**Derived, not stored:** venue is `venue_dex + venue_lending + venue_exchange`. Circulating is `total_supply - issuer_inventory - placed_supply`.

**A `system` wallet's balance counts as free-floating**, which is 117.50 OUSD today. It is too small to need its own column.

**Reference values on the 2026-11-04 snapshot.** These are for a manual check once, not test assertions, because the data moves.

| chain, day | total | issuer | placed | dex | lending | exchange | free | placed wallets | holders |
|---|---|---|---|---|---|---|---|---|---|
| tempo, 2026-11-03 | 605,516,280.37 | 9,399,093.12 | 466,155,863.62 | 7,991,564.51 | 44,582,450.60 | 0 | 77,387,308.52 | 29 | 1,400 |
| ethereum, 2026-10-21 | 129,502,660.49 | 10,068,661.68 | 89,729,617.00 | 46,386.51 | 0 | 224,994.98 | 29,433,000.32 | 14 | 148 |

**Test scenarios (pytest).** Use `placed_days: 14` and `placed_min_base_units` of $1M unless stated. Amounts in OUSD.

- **Full stay:** a wallet funded $5M 20 days ago and untouched is placed at $5M.
- **Too new:** funded $5M 10 days ago: not placed, counts as free-floating. It becomes placed exactly on day 14 after funding, and not on day 13.
- **Dust out:** funded $5M 20 days ago, sent $1 yesterday: placed is $4,999,999. The PRD's old rule would have returned 0.
- **Half moved:** funded $5M 20 days ago, sent $3M 5 days ago: placed is $2M, free-floating is $0 for the rest, because the rest has left.
- **Below threshold after moving:** funded $5M, sent $4.5M 5 days ago: placed 0, free-floating $0.5M.
- **Dip inside a day:** sent $4M and received $4M back on the same day, 3 days ago: placed is $1M, not $5M. Proves `day_min`, not close, drives it.
- **Dip before the window:** a dip on the day exactly 14 days ago, closed back up by that day's end, doesn't count. Proves the window boundary.
- **Refill:** $5M for 20 days, then received another $3M yesterday: placed stays $5M, free-floating $3M.
- **Labeled wallets are never placed:** the same stay in `dex`, `lending`, `exchange`, `issuer` and `system` wallets gives placed 0.
- **Silent days:** a wallet with no event today still appears in today's row at its old balance.
- **Zero address** never appears as a wallet.
- **Coverage:** no rows after `last_complete_day`.
- **Precision:** $1 of a balance above 2^64 base units is preserved.
- **Variable:** `placed_days: 7` changes the result as expected.
- **Failure tests:** tampered fixtures make `assert_no_negative_balances` fail (a transfer out with no funding) and make `assert_journey_matches_events` fail if a row is excluded.

**dbt tests:** `not_null` on all mart columns except `top10_value`, a singular test that `(chain, day_utc)` is unique, and the three above.

## Unit 2.5: mart_activity_waterfall and mart_activity_kpis

**Delivers:** view B's data: how much of headline volume is real, plus velocity and active wallets.

**Paths:** create the three intermediate models and two marts below, `tests/test_activity_waterfall.py`, `tests/test_activity_kpis.py`, and two singular tests. Extend the `_*.yml` files.

**Contract**

`dbt/models/intermediate/int_transfer_classes.sql`

```sql
with ordered as (
    select
        *,
        row_number() over (partition by chain, tx_hash order by log_index desc) as rn_desc
    from {{ ref('stg_transfers') }}
)

select
    t.chain,
    t.block_number,
    t.log_index,
    t.day_utc,
    t.tx_hash,
    t.from_address,
    t.to_address,
    t.value,
    case
        when t.from_address = '{{ var("zero_address") }}' then 'mint'
        when t.to_address = '{{ var("zero_address") }}' then 'burn'
        when t.chain = 'tempo' and t.to_address = '{{ var("tempo_fee_manager") }}' and t.rn_desc = 1 then 'fee'
        when t.chain = 'tempo' and '{{ var("tempo_fee_manager") }}' in (t.from_address, t.to_address) then 'fee_liquidity'
        when lf.category in ('issuer', 'issuer_route') or lt.category in ('issuer', 'issuer_route') then 'issuer_flow'
        when lf.entity = lt.entity then 'same_entity'
        else 'remaining'
    end as transfer_class
from ordered as t
left join {{ ref('stg_labels') }} as lf on lf.chain = t.chain and lf.address = t.from_address
left join {{ ref('stg_labels') }} as lt on lt.chain = t.chain and lt.address = t.to_address
```

`dbt/models/intermediate/int_tx_net.sql`

```sql
with legs as (
    select chain, tx_hash, day_utc, to_address as address, value as delta
    from {{ ref('int_transfer_classes') }}
    where transfer_class = 'remaining'
    union all
    select chain, tx_hash, day_utc, from_address as address, -value as delta
    from {{ ref('int_transfer_classes') }}
    where transfer_class = 'remaining'
)

select
    l.chain,
    l.tx_hash,
    l.address,
    min(l.day_utc) as day_utc,
    cast(sum(l.delta) as hugeint) as net_value,
    any_value(lb.category) as category
from legs as l
left join {{ ref('stg_labels') }} as lb on lb.chain = l.chain and lb.address = l.address
group by l.chain, l.tx_hash, l.address
```

`dbt/models/intermediate/int_tx_decomposition.sql`

```sql
with gross as (
    select chain, tx_hash, min(day_utc) as day_utc, cast(sum(value) as hugeint) as gross_value
    from {{ ref('int_transfer_classes') }}
    where transfer_class = 'remaining'
    group by chain, tx_hash
),

nets as (
    select
        chain,
        tx_hash,
        coalesce(sum(net_value) filter (where net_value > 0), 0) as moved,
        greatest(
            coalesce(sum(net_value) filter (where net_value > 0 and category = 'dex'), 0),
            coalesce(-sum(net_value) filter (where net_value < 0 and category = 'dex'), 0)
        ) as dex_raw,
        greatest(
            coalesce(sum(net_value) filter (where net_value > 0 and category = 'lending'), 0),
            coalesce(-sum(net_value) filter (where net_value < 0 and category = 'lending'), 0)
        ) as lending_raw
    from {{ ref('int_tx_net') }}
    group by chain, tx_hash
),

parts as (
    select
        g.chain,
        g.tx_hash,
        g.day_utc,
        g.gross_value,
        g.gross_value - n.moved as same_tx_netting,
        n.moved,
        least(n.moved, n.dex_raw) as dex_flow,
        least(n.moved - least(n.moved, n.dex_raw), n.lending_raw) as lending_flow
    from gross as g
    inner join nets as n on n.chain = g.chain and n.tx_hash = g.tx_hash
)

select
    chain,
    tx_hash,
    day_utc,
    cast(gross_value as hugeint) as gross_value,
    cast(same_tx_netting as hugeint) as same_tx_netting,
    cast(dex_flow as hugeint) as dex_flow,
    cast(lending_flow as hugeint) as lending_flow,
    cast(moved - dex_flow - lending_flow as hugeint) as clean_value
from parts
```

`dbt/models/marts/mart_activity_waterfall.sql`

```sql
{% set large = var("large_transfer_base_units") %}

with rows_part as (
    select
        chain,
        day_utc,
        count(*) as transfer_count,
        cast(sum(value) as hugeint) as headline_value,
        cast(coalesce(sum(value) filter (where transfer_class = 'mint'), 0) as hugeint) as minted,
        cast(coalesce(sum(value) filter (where transfer_class = 'burn'), 0) as hugeint) as burned,
        cast(coalesce(sum(value) filter (where transfer_class = 'fee'), 0) as hugeint) as fees,
        count(*) filter (where transfer_class = 'fee') as fee_count,
        cast(coalesce(sum(value) filter (where transfer_class = 'fee_liquidity'), 0) as hugeint) as fee_liquidity,
        cast(coalesce(sum(value) filter (where transfer_class = 'issuer_flow'), 0) as hugeint) as issuer_flows,
        cast(coalesce(sum(value) filter (where transfer_class = 'same_entity'), 0) as hugeint) as same_entity
    from {{ ref('int_transfer_classes') }}
    group by chain, day_utc
),

tx_part as (
    select
        chain,
        day_utc,
        cast(sum(same_tx_netting) as hugeint) as same_tx_netting,
        cast(sum(dex_flow) as hugeint) as dex_flow,
        cast(sum(lending_flow) as hugeint) as lending_flow,
        cast(coalesce(sum(clean_value) filter (where clean_value >= {{ large }}), 0) as hugeint) as clean_large,
        cast(coalesce(sum(clean_value) filter (where clean_value < {{ large }}), 0) as hugeint) as clean_everyday,
        count(*) filter (where clean_value >= {{ var("clean_tx_min_base_units") }}) as clean_tx_count
    from {{ ref('int_tx_decomposition') }}
    group by chain, day_utc
)

select
    r.*,
    cast(coalesce(x.same_tx_netting, 0) as hugeint) as same_tx_netting,
    cast(coalesce(x.dex_flow, 0) as hugeint) as dex_flow,
    cast(coalesce(x.lending_flow, 0) as hugeint) as lending_flow,
    cast(coalesce(x.clean_large, 0) as hugeint) as clean_large,
    cast(coalesce(x.clean_everyday, 0) as hugeint) as clean_everyday,
    coalesce(x.clean_tx_count, 0) as clean_tx_count
from rows_part as r
left join tx_part as x on x.chain = r.chain and x.day_utc = r.day_utc
inner join {{ ref('stg_sync_coverage') }} as c on c.chain = r.chain
where r.day_utc <= c.last_complete_day
```

`dbt/models/marts/mart_activity_kpis.sql`

```sql
with journey as (
    select
        chain,
        day_utc,
        total_supply,
        total_supply - issuer_inventory - placed_supply as circulating_supply
    from {{ ref('mart_supply_journey') }}
),

rolled as (
    select
        chain,
        day_utc,
        sum(headline_value) over w as headline_7d,
        sum(clean_large + clean_everyday) over w as clean_7d,
        sum(clean_everyday) over w as clean_everyday_7d,
        count(*) over w as days_in_window
    from {{ ref('mart_activity_waterfall') }}
    window w as (partition by chain order by day_utc rows between 6 preceding and current row)
),

senders as (
    select n.chain, n.day_utc, n.address, -n.net_value as sent
    from {{ ref('int_tx_net') }} as n
    inner join {{ ref('int_tx_decomposition') }} as d on d.chain = n.chain and d.tx_hash = n.tx_hash
    where n.net_value < 0
        and d.clean_value > 0
        and (n.category is null or n.category = 'exchange')
),

active as (
    select
        j.chain,
        j.day_utc,
        s.address,
        sum(s.sent) as sent_7d
    from journey as j
    inner join senders as s
        on s.chain = j.chain and s.day_utc between j.day_utc - 6 and j.day_utc
    group by j.chain, j.day_utc, s.address
),

active_counts as (
    select
        chain,
        day_utc,
        count(*) filter (where sent_7d >= {{ var("active_dust_base_units") }}) as active_wallets_7d,
        count(*) filter (where sent_7d >= {{ var("active_secondary_base_units") }}) as active_wallets_over_100_7d
    from active
    group by chain, day_utc
)

select
    j.chain,
    j.day_utc,
    j.total_supply,
    j.circulating_supply,
    cast(r.headline_7d as hugeint) as headline_7d,
    cast(r.clean_7d as hugeint) as clean_7d,
    cast(r.clean_everyday_7d as hugeint) as clean_everyday_7d,
    case when r.days_in_window = 7 and j.circulating_supply > 0 then cast(r.clean_7d * 10000 // (7 * j.circulating_supply) as integer) end as velocity_bps,
    case when r.days_in_window = 7 and j.circulating_supply > 0 then cast(r.clean_everyday_7d * 10000 // (7 * j.circulating_supply) as integer) end as velocity_everyday_bps,
    case when r.days_in_window = 7 and j.total_supply > 0 then cast(r.headline_7d * 10000 // (7 * j.total_supply) as integer) end as headline_velocity_bps,
    coalesce(a.active_wallets_7d, 0) as active_wallets_7d,
    coalesce(a.active_wallets_over_100_7d, 0) as active_wallets_over_100_7d
from journey as j
inner join rolled as r on r.chain = j.chain and r.day_utc = j.day_utc
left join active_counts as a on a.chain = j.chain and a.day_utc = j.day_utc
```

`dbt/tests/assert_waterfall_adds_up.sql`

```sql
select chain, day_utc
from {{ ref('mart_activity_waterfall') }}
where headline_value <> minted + burned + fees + fee_liquidity + issuer_flows + same_entity
    + same_tx_netting + dex_flow + lending_flow + clean_large + clean_everyday
```

`dbt/tests/assert_fee_rule_shape.sql`

```sql
-- The largest real fee seen is 1.07 OUSD. A fee above 10 OUSD means the rule has caught a real transfer.
select chain, tx_hash, value
from {{ ref('int_transfer_classes') }}
where transfer_class = 'fee' and value > 10000000
```

**Reference values on the 2026-11-04 snapshot**, Day 0 through each chain's last complete day. Clean is `clean_large + clean_everyday`.

| chain | headline | minted | burned | issuer flows | netting | dex | lending | large | everyday |
|---|---|---|---|---|---|---|---|---|---|
| tempo | 2,319.40M | 282.15M | 101.09M | 985.79M | 396.44M | 14.34M | 50.23M | 473.13M | 16.23M |
| ethereum | 730.98M | 122.06M | 2.46M | 138.00M | 2.32M | 1.52M | 0 | 461.73M | 2.89M |

KPIs, Tempo 2026-11-03: `velocity_bps` 608, `velocity_everyday_bps` 50, `headline_velocity_bps` 1744, `active_wallets_7d` 136, `active_wallets_over_100_7d` 59. Ethereum, 2026-10-21: 55, 55, 230, 30, 20.

**Test scenarios (pytest), classification**
- A mint and a burn class as `mint` and `burn` even when the other side is labeled.
- **Fee rule:** the last OUSD transfer to the fee manager in its transaction is `fee`.
- **The real exception:** a transaction with a 50 OUSD transfer to the fee manager, then a 0.0005 transfer to it. First is `fee_liquidity`, last is `fee`.
- A transfer from the fee manager is `fee_liquidity`.
- A transfer to the same address on `ethereum` isn't `fee`. The rule is Tempo-only.
- A transfer with an `issuer` or `issuer_route` wallet on either side is `issuer_flow`.
- Same non-null `entity` on both sides is `same_entity`. Two unlabeled wallets aren't. Two empty-entity route wallets are `issuer_flow`, not `same_entity`.

**Test scenarios (pytest), decomposition**
- **The loop:** A to B, B to A, repeated 4 times with the same value in one transaction: `same_tx_netting` is the full gross, clean is 0.
- **Multi-hop:** A to B to C to D with the same value in one transaction: gross is 3v, netting is 2v, clean is v.
- **Split:** A sends 10 to B and 5 to C: clean is 15, netting 0.
- **Partial pass-through:** A to B 10, B to C 7: moved is 10, netting is 7. B keeps 3.
- **DEX swap flow:** a user sends 10 to a `dex` wallet and gets nothing in OUSD back: `dex_flow` 10, clean 0. A DEX sends 10 to a user: `dex_flow` 10, clean 0.
- **Deposit through a router:** user to router to `lending`: `lending_flow` v, netting v, clean 0.
- **Both venues in one transaction:** dex first, capped so the parts never exceed moved. No negative `clean_value`.
- **Split at the threshold:** exactly $1M is `clean_large`. $999,999.999999 is `clean_everyday`.
- **The identity:** random synthetic transactions (a seeded generator, 200 transactions, mixing all classes) leave `assert_waterfall_adds_up` passing.
- **Failure test:** after tampering with a mart row through a test-only model or fixture, `assert_waterfall_adds_up` reports it. If that isn't practical, test its SQL directly against a handmade table.

**Test scenarios (pytest), KPIs**
- Fewer than 7 days of history: velocity is null, not a misleading number.
- Zero circulating supply: velocity is null, with no division error.
- Velocity is integer division, checked with a value that would round up.
- Active wallets: a sender with $0.99 isn't counted, a sender with $1.00 is. A sender with $0.60 and $0.40 in two transactions in the window is.
- A wallet active 7 days ago is in the window; 8 days ago is not.
- A wallet labeled `dex`, `lending`, `issuer` or `system` is never counted. One labeled `exchange` is.
- A pass-through wallet (net 0) isn't a sender.
- A sender in a transaction that nets to zero isn't counted.

**dbt tests:** `not_null` on all waterfall columns, `(chain, day_utc)` uniqueness on both marts, and `assert_waterfall_adds_up`.

**Known limit, stated on the methodology page:** netting works within a transaction, so a hop across transactions still counts more than once. It's mostly contained by the $1M split. `dex_flow` isn't trading volume.

## Unit 2.6: mart_chain_roles and mart_reconciliation

**Delivers:** view E's data and the trust strip's data.

**Paths:** create the two marts below, `tests/test_chain_roles.py`, `tests/test_reconciliation_mart.py`. Extend `_marts.yml`.

**Contract**

`dbt/models/marts/mart_chain_roles.sql`

```sql
with latest as (
    select chain, max(day_utc) as as_of_day
    from {{ ref('mart_supply_journey') }}
    group by chain
),

journey as (
    select j.*
    from {{ ref('mart_supply_journey') }} as j
    inner join latest as l on l.chain = j.chain and l.as_of_day = j.day_utc
),

activity as (
    select
        w.chain,
        cast(sum(w.minted) as hugeint) as minted_30d,
        cast(sum(w.burned) as hugeint) as burned_30d,
        cast(sum(w.dex_flow) as hugeint) as dex_flow_30d,
        cast(sum(w.lending_flow) as hugeint) as lending_flow_30d,
        cast(sum(w.clean_large + w.clean_everyday) as hugeint) as clean_30d,
        cast(sum(w.clean_everyday) as hugeint) as clean_everyday_30d
    from {{ ref('mart_activity_waterfall') }} as w
    inner join latest as l on l.chain = w.chain
    where w.day_utc > l.as_of_day - 30 and w.day_utc <= l.as_of_day
    group by w.chain
)

select
    j.chain,
    j.day_utc as as_of_day,
    j.total_supply,
    cast(j.total_supply * 10000 // sum(j.total_supply) over () as integer) as supply_share_bps,
    cast(j.placed_supply * 10000 // j.total_supply as integer) as placed_share_of_chain_bps,
    a.minted_30d,
    a.burned_30d,
    a.dex_flow_30d,
    a.lending_flow_30d,
    a.clean_30d,
    a.clean_everyday_30d,
    cast(a.clean_everyday_30d * 10000 // nullif(sum(a.clean_everyday_30d) over (), 0) as integer) as clean_everyday_share_bps,
    cast(a.dex_flow_30d * 10000 // nullif(sum(a.dex_flow_30d) over (), 0) as integer) as dex_flow_share_bps
from journey as j
inner join activity as a on a.chain = j.chain
```

`dbt/models/marts/mart_reconciliation.sql`

```sql
with chain_rows as (
    select
        'chain' as kind,
        chain as subject,
        block_number,
        minted - burned as event_value,
        onchain_supply as reference_value,
        minted - burned - onchain_supply as difference,
        matched as passed,
        checked_at,
        row_number() over (partition by chain order by checked_at desc) as rn
    from {{ source('raw', 'reconciliations') }}
),

bridge_rows as (
    select
        'bridge' as kind,
        'all_chains' as subject,
        cast(null as bigint) as block_number,
        chains_total as event_value,
        bridge_total as reference_value,
        chains_total - bridge_total as difference,
        passed,
        checked_at,
        row_number() over (order by checked_at desc) as rn
    from {{ source('raw', 'bridge_comparisons') }}
)

select kind, subject, block_number, event_value, reference_value, difference, passed, checked_at
from chain_rows
where rn = 1
union all
select kind, subject, block_number, event_value, reference_value, difference, passed, checked_at
from bridge_rows
where rn = 1
```

**Chain roles don't carry a role name in SQL.** Publish adds `leading_for`, the list of measures where this chain has the largest share: `supply`, `issuance` (minted in 30 days), `everyday`, `dex_flow`, `lending_flow`. Written sentences belong to the site. Chains are at different as-of days until all syncs finish, so publish must carry `as_of_day` per chain, and the site must show it.

**Test scenarios (pytest)**
- Two chains: shares sum to at most 10000 (floor division), and each `as_of_day` is that chain's own.
- A chain with no DEX flow gets 0 and no division error. If no chain has any, the share is null.
- The 30-day window: a mint exactly 30 days before `as_of_day` is out, 29 days before is in.
- `mart_reconciliation`: of two rows for a chain, only the newest appears. `difference` is exact above 2^64. A chain mismatch surfaces `passed = false`.
- No `bridge_comparisons` rows gives chain rows only. A row gives one `bridge` row.

**dbt tests:** `not_null` and `unique` on `chain` in roles; `accepted_values` on `kind`.

## Unit 2.8: checks, publish step and dataset schema

**Delivers:** the seven blocking checks as plain functions, and a publish step that refuses to run unless they all passed. Works without Dagster.

**Paths**
- Create `pipeline/ousd/checks.py`, `pipeline/ousd/publish.py`, `pipeline/ousd/verdict.py`, `pipeline/ousd/schemas/*.schema.json`, `tests/test_checks.py`, `tests/test_publish.py`, `tests/test_verdict.py`.
- Modify `pipeline/ousd/store.py` (`check_results`), `pipeline/ousd/cli.py` (`check`, `publish`), `pyproject.toml` (`jsonschema>=4`; package the schema files).

**Raw table addition, in `store.py`'s `SCHEMA`.** `balance_of` and the `bridge_comparisons` statement aren't added here: unit 1.4 adds them first (`RpcClient.balance_of` and the table), and unit 2.2 can keep its `CREATE TABLE IF NOT EXISTS`.

```sql
CREATE TABLE IF NOT EXISTS check_results (
    run_id VARCHAR NOT NULL,
    check_name VARCHAR NOT NULL,
    status VARCHAR NOT NULL,  -- passed, failed, skipped
    blocking BOOLEAN NOT NULL,
    detail VARCHAR NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, check_name)
);
```

**Blocking checks**, one function each in `checks.py`. Each returns `CheckResult(name, status, blocking, detail)`.

| Name | Passes when | Numbers |
|---|---|---|
| `chain_supply` | The newest `reconciliation_checks` row of `chain_supply` for each required chain has passed, and its block equals `sync_state.synced_through`, read in the same run | Exact |
| `cross_chain_supply` | All four chains present, and the newest finished run's `bridge` result passed. It doesn't re-read Bridge or retry, because the tip-read rule and its tolerance would be weaker than, and could disagree with, the one recorded | Exact. The recorded `bridge_comparisons` row has tolerance 0 |
| `sampled_balances` | For each chain, the running balance from `int_wallet_events` equals the `balance_samples` row from that run, at the same block, with no network. This still catches a dbt error, which unit 1.4's own check can't, and needs no second sample | Exact. |
| `dbt_tests` | `dbt build` exited 0. Dagster's dbt asset passes this, and the CLI reads `dbt/target/run_results.json` | Any failure blocks |
| `volume_waterfall` | Sum of parts equals headline for every chain and day, read from the mart | Exact. Separately from the dbt test, so it's named in the manifest |
| `reconciliation_gate` | `Store.latest_reconciliation()` meets the gate rule: the newest finished run has `scope = 'full'` and `status = 'pass'`, and each chain's cursor, pin hash and transfer count still equal what that run recorded. Its own blocking check, because the checks above can pass on `reconciliations.matched` while the run is `fail` or `unchecked`, for example with a group that isn't real | Exact |
| `freshness` | For each chain, newest transfer within 36 hours, and newest reconciliation within 36 hours | 36 hours, for a daily schedule with room for one retry |

**Where the earlier tolerance came from.** Unit 1.4 replaced it with an exact match, so no amount is allowed now. The measurements stay as a record of how far Bridge's figure moves: across Tempo and Ethereum since October 5, hourly net issuance had a median of $121, a 95th percentile of $1.0M, a 99th percentile of $10.0M and a maximum of $40.4M. A live read on 2026-11-04 differed from Bridge by $1,134.

**The sampled balance check must stay blocking.** The build log records that a lagging Blockscout index can silently skip transfers, and reconciliation only catches that for mints and burns.

**Non-blocking warnings**, in the manifest: day-over-day change above 25% in total, placed or circulating, or above 100% in 7-day everyday volume.

**Partial coverage.** The expected chains are `REQUIRED_CHAINS` in `chains.py`, so there is one list. With a chain missing, `cross_chain_supply` and `reconciliation_gate` are `failed` and publish refuses. With `--allow-partial` on the CLI (or `OUSD_ALLOW_PARTIAL=1`), they are `skipped` instead, the other checks run for the chains present, and the manifest says `coverage.complete: false`. This is a local preview for Phase 3 development, **never for a public release**.

**Interfaces**

```python
# checks.py
@dataclass(frozen=True)
class CheckResult:
    name: str
    status: Literal["passed", "failed", "skipped"]
    blocking: bool
    detail: str


def run_checks(
    store: Store,
    marts: duckdb.DuckDBPyConnection,
    chains: list[Chain],
    run_id: str,
    allow_partial: bool = False,
) -> list[CheckResult]: ...  # also writes check_results


# publish.py
class PublishRefused(RuntimeError): ...


def publish(
    run_id: str,
    marts_path: Path,
    raw_path: Path,
    out_root: Path,
    allow_partial: bool = False,
    now: datetime | None = None,
) -> Path:
    """Read check_results for run_id and refuse unless all seven are present and acceptable.
    Write a new dated folder, validate it against the schemas, then repoint `latest`.
    Return the new folder. Never touches `latest` on failure."""


# verdict.py
def build_verdict(rows: VerdictInputs) -> Verdict: ...
```

**CLI:** `ousd check --run-id ID [--allow-partial]` and `ousd publish --run-id ID [--allow-partial]`. Exit 1 on failure or refusal.

**Output layout**

```
data/published/
  20261104T060000Z/
    manifest.json
    summary.json
    journey.json       journey.csv
    activity.json      activity.csv
    chain_roles.json   chain_roles.csv
    reconciliation.json
  latest -> 20261104T060000Z
```

Write to `<stamp>.tmp`, validate, rename, then create a temporary symlink and `os.replace` it onto `latest`. So a reader never sees a half-written dataset. Keep the last 14 folders.

## Dataset schema

Version 1. The Phase 3 site depends on this, and validates it at build. Any breaking change bumps `schema_version`.

**Rules for every file**
- Amounts are strings of integer base units (6 decimals), matching `^-?[0-9]+$`. The site formats them.
- Ratios are integers in basis points, or null when undefined.
- Days are `YYYY-MM-DD`, times are ISO 8601 UTC.
- Each JSON file has `schema_version: 1`, and `data` as an array, sorted by `chain` then `day`. Each per-chain row includes `chain`.
- JSON Schemas live in `pipeline/ousd/schemas/`, with `additionalProperties: false`.

**`manifest.json`**

```json
{
  "schema_version": 1,
  "dataset_version": "20261104T060000Z",
  "generated_at": "2026-11-04T06:03:12Z",
  "git_commit": "e46cc46",
  "stale": false,
  "coverage": {
    "chains_expected": ["tempo", "ethereum", "base", "solana"],
    "chains_included": ["tempo", "ethereum"],
    "complete": false,
    "data_as_of": {"tempo": "2026-11-03", "ethereum": "2026-10-21"},
    "synced_through": {"tempo": 47312916, "ethereum": 26244799}
  },
  "checks": [
    {"name": "chain_supply", "status": "passed", "blocking": true, "detail": "tempo, ethereum matched"}
  ],
  "warnings": [],
  "definitions": {
    "placed_days": 14,
    "placed_min_base_units": "1000000000000",
    "large_transfer_base_units": "1000000000000",
    "active_dust_base_units": "1000000",
    "active_secondary_base_units": "100000000",
    "journey_first_day": "2026-10-14"
  },
  "labels_sha256": "...",
  "files": {"journey.json": {"sha256": "...", "rows": 73}}
}
```

`stale` is always false on write. The site sets its own stale banner by comparing `generated_at` with the current time at build, because a failed run writes nothing.

**`summary.json`:** the first screen.

```json
{
  "schema_version": 1,
  "verdict": {"state": "mostly_placed", "scope": ["tempo"], "text": "..."},
  "kpis": [
    {"chain": "tempo", "day": "2026-11-03", "total_supply": "605516280370000",
     "placed_supply": "466155863617817", "placed_share_bps": 7698,
     "circulating_supply": "129961323631959", "clean_everyday_7d": "4627061301100",
     "velocity_bps": 608, "velocity_everyday_bps": 50, "headline_velocity_bps": 1744,
     "active_wallets_7d": 136, "active_wallets_over_100_7d": 59}
  ]
}
```

**`journey.json`:** one row per chain and day, from `mart_supply_journey`, with the same column names but `day_utc` renamed `day`. Publish omits days before Day 0 (2026-09-30) plus `placed_days`, so 2026-10-14 at the default, because placed reads artificially low until wallets are old enough. The first day is recorded in `definitions` as `journey_first_day`.

**`activity.json`:** one row per chain and day, joining `mart_activity_waterfall` and `mart_activity_kpis`, with the same column names and `day`.

**`chain_roles.json`:** one row per chain, from `mart_chain_roles`, plus `leading_for`, with `as_of_day`.

**`reconciliation.json`:** rows from `mart_reconciliation`. `kind`, `subject`, `block_number` (nullable), `event_value`, `reference_value`, `difference`, `passed`, `checked_at`.

**CSV:** `journey`, `activity` and `chain_roles`, same columns and base units, flattening `leading_for` with `;`.

**Labels are not published in Phase 3.** Journey and activity are aggregates, so no wallet appears. Only the Sentora vault and similar named venues reach the site, through the methodology page. This keeps doxxing risk low. Revisit for view C.

**Verdict.** `verdict.py` picks a template by state, computed from the chains with data. `scope` lists those chains, and the text names them.

| State | When |
|---|---|
| `mostly_placed` | Placed share is 50% or more |
| `moving` | Placed share under 50% and 7-day everyday volume at least 5% of supply |
| `mixed` | Otherwise |

The `mostly_placed` template follows the candidate in the brainstorm: "On {chains}, which hold about {share}% of OUSD, {placed}% of supply has sat still for at least {N} days in wallets of $1M or more, and transfers under $1M moved {everyday} in the last week, {pct}% of supply." Share of OUSD comes from Bridge's total. The 5% threshold is a judgment, and the maintainer reviews all template wording before release.

**Test scenarios (pytest), checks**
- **Gate:** with `reconciliations` matched but the newest run `fail` or `unchecked` (for example, a same-looking group that isn't real), `reconciliation_gate` fails and publish refuses. A `pass` whose cursor, pin hash or transfer count has since changed also fails. **This must land before any publish code runs on real data.**
- Each check passes on good data and fails on one tampered value, including a one base unit mismatch for `chain_supply` and `sampled_balances`.
- `chain_supply` fails if the newest reconciliation is older than `synced_through`.
- `cross_chain_supply`: a recorded `pass` passes; `fail` and `unchecked` fail; it makes no Bridge request and never retries; a missing chain fails, or is `skipped` with `allow_partial`.
- `sampled_balances`: compares against `balance_samples` with no RPC. A tampered model balance by one base unit fails.
- `freshness`: 35h59m passes, 36h01m fails, on a fake clock.
- `run_checks` writes one `check_results` row per check. A rerun with the same `run_id` replaces rows.
- Warnings never block.

**Test scenarios (pytest), publish**
- All passed writes the folder, updates `latest`, and every file validates against its schema.
- One check `failed`: raises `PublishRefused`, `latest` is unchanged, no folder remains.
- A missing check row refuses, as does a `run_id` with no rows.
- `skipped` is refused without `allow_partial`.
- **A schema failure** (for instance, an amount written as a float) raises, and `latest` is unchanged.
- Amounts above 2^53 survive as exact strings.
- Rerunning with the same data is byte-identical apart from `generated_at` and `dataset_version`.
- `manifest.files` hashes match the files on disk.
- `manifest.coverage` is correct with two chains and with four.
- Only the 14 newest folders stay. `latest` is never removed.
- A published row contains no wallet address. Scan all files for `0x` followed by 40 hex characters.

**Test scenarios (pytest), verdict:** each state at and around its boundary; the text never says "all chains" when `scope` is partial; no name of any partner appears in the text.

## Unit 2.7: Dagster assets, schedule and blocking checks

**Delivers:** one command that runs ingest to publish, a daily schedule, retries, and a failed check that stops publishing.

**Paths**
- Create `pipeline/dagster/definitions.py`, `tests/test_dagster_definitions.py`.
- Modify `pyproject.toml` (`dagster>=1.8`, dev group `dagster-webserver`), `Makefile` (`run`, `dagster-dev`), `README.md` (how to run), `.env.example`.

**Do not add `__init__.py` to `pipeline/dagster/`, and never put `pipeline/` on `PYTHONPATH`,** or the folder can shadow the `dagster` package. Load it only as a file: `-f pipeline/dagster/definitions.py`.

**Contract**

Assets, in dependency order:

| Asset | Calls | Notes |
|---|---|---|
| `raw_transfers` | `sync_chain` per chain | Closes `Store` before returning |
| `chain_reconciliations` | `run_reconciliation`, not `reconcile_chain` per chain | Runs right after sync, since public nodes only serve recent state. Raises when `RunResult` isn't `pass`, since a programmatic caller gets no exit code |
| `dbt_marts` | `dbt build --project-dir dbt --profiles-dir dbt` via `subprocess` | Non-zero exit fails the asset |
| `published_dataset` | `ousd.publish.publish(context.run_id, ...)` | Refuses by itself if checks didn't pass |

Blocking checks, `@asset_check(asset=dbt_marts, blocking=True)`, one for each of the seven names, each calling its function in `checks.py` and writing to `check_results` with `context.run_id`. `published_dataset` depends on `dbt_marts`, so a failed blocking check stops it. `publish` checks `check_results` itself as well, so there are **two independent gates**.

- **Job:** `ousd_daily`, `define_asset_job` selecting all assets, with `executor_def=in_process_executor`. **In-process is required,** because DuckDB allows one writer per file and parallel steps would collide.
- **Schedule:** `ScheduleDefinition(job=..., cron_schedule="0 6 * * *", execution_timezone="UTC")`.
- **Retries:** `RetryPolicy(max_retries=2, delay=300)` on `raw_transfers` and `chain_reconciliations` only. Never retry a check failure. A failed check should be read by a person.
- **Failure alert:** a `@run_failure_sensor` that logs an error and writes `data/alerts/<run_id>.json`. Outbound alerts wait for the maintainer, because the project rules restrict outbound actions.

**One command:** `make run` runs `uv run --locked $(ENV_FILE) dagster job execute -f pipeline/dagster/definitions.py -j ousd_daily`. `make dagster-dev` runs `dagster dev -f pipeline/dagster/definitions.py`. Set `DAGSTER_HOME=$(CURDIR)/data/.dagster` in the Makefile and create the folder first: Dagster requires an absolute path. `data/` is already gitignored.

**Decision: no Dagster partitions.** R5 asks for partitioned jobs. Ingest is cursor-based and idempotent, and dbt rebuilds in seconds, so a partition per day would add code and a backfill path that can disagree with the cursor. Re-running any range is already safe. `docs/architecture.md` and R5 are updated to say so.

**Decision: dbt as one asset.** `dagster-dbt` gives a lineage view per model, but it needs a manifest at load time and more moving parts. dbt already has lineage. Switching later is contained to this file.

**Test scenarios (pytest).** All use `materialize` or `job.execute_in_process` with fakes and no network.
- `definitions.py` loads, with the job, schedule and seven checks, all blocking.
- **Happy path:** with fake chain sources and a small fixture, the job runs end to end and `latest` exists.
- **A failed blocking check** (make `volume_waterfall` return failed): the run reports failure, `published_dataset` doesn't materialize, and `latest` is unchanged. **This test is the done-when for the phase.**
- **dbt test failure:** a fixture with a negative-balance wallet makes `dbt_marts` fail, and nothing downstream runs.
- A transient source error is retried, then succeeds.
- A second run with no new data changes no raw rows.
- The schedule's cron is `0 6 * * *` in UTC.

## Phase done when

- `make run` goes from ingest to `data/published/latest`, using real data.
- A failed check stops publishing, proved by the test above.
- A week of scheduled runs passes, per the PRD (hosted schedules come later, so this means runs on a local machine).
- Every metric on PRD section 7 maps to a column in the published dataset:

| PRD metric | Dataset field |
|---|---|
| Minted, burned, net issuance | `activity.minted`, `activity.burned` |
| Placed | `journey.placed_supply` |
| Issuer inventory | `journey.issuer_inventory` |
| Venue | `journey.venue_dex`, `venue_lending`, `venue_exchange` |
| Circulating | `kpis.circulating_supply`, also `activity.circulating_supply` |
| Headline | `activity.headline_value` |
| Clean | `activity.clean_large`, `clean_everyday` |
| Velocity | `activity.velocity_bps`, `velocity_everyday_bps`, `headline_velocity_bps` |
| Active wallets | `activity.active_wallets_7d`, `active_wallets_over_100_7d` |
| Concentration | `journey.top10_value`, `holders`, `holders_over_1m` |
| Implied reserve income | Later, Phase 5, view F |

## Risks and how to handle them

| Risk | Response |
|---|---|
| dbt can't attach `ousd.duckdb` because something holds the write lock | Fails loudly. Close `Store` before dbt. A sync run outside Dagster will block it, so don't run both |
| Marts grow slowly as wallets and days multiply | `int_wallet_days` is wallets times days. Today it's small and the whole build takes seconds. If it passes a minute, make it incremental. Not before |
| Solana shape breaks netting or balances | Its contract is in Prerequisites. Add the tests above with Solana-shaped rows in units 2.3, 2.4 and 2.5 |
| A label error changes a published number | Labels are reviewed, and each label is one row. `labels_sha256` in the manifest traces which version was used |
| `transfers` rows differ across a Blockscout and RPC boundary | Recorded in the build log. `assert_unique_transfer_key` won't catch duplicates at new positions, and `sampled_balances` catches their effect only partly, as a looping duplicate nets to zero. Unit 1.4's U3 and U6 cover that case |
