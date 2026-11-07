-- The newest recorded result per chain, and the newest Bridge comparison, each beside the
-- newest finished run. A Bridge row carries its own run_id: when the newest run made no
-- comparison (a partial run, an outage), the newest row belongs to an older run and
-- in_latest_run is false. Blocking publish is the gate's job, not this mart's.
with latest_run as (
    select run_id, scope, status, finished_at
    from {{ source('raw', 'reconciliation_runs') }}
    where finished_at is not null
    order by finished_at desc, started_at desc, run_id desc
    limit 1
),

chain_rows as (
    select
        chain,
        block_number,
        checked_at,
        matched as passed,
        onchain_supply as reference_value,
        minted - burned as event_value,
        minted - burned - onchain_supply as difference,
        row_number() over (partition by chain order by checked_at desc, block_number desc) as rn
    from {{ source('raw', 'reconciliations') }}
),

bridge_rows as (
    select
        passed,
        checked_at,
        run_id,
        chains_total as event_value,
        bridge_total as reference_value,
        chains_total - bridge_total as difference,
        row_number() over (order by checked_at desc, run_id desc) as rn
    from {{ source('raw', 'bridge_comparisons') }}
),

newest as (
    select
        block_number, chain as subject, passed, checked_at, event_value, reference_value,
        difference,
        'chain' as kind,
        cast(null as varchar) as run_id
    from chain_rows
    where rn = 1
    union all
    select
        cast(null as bigint) as block_number,
        'all_chains' as subject,
        passed, checked_at, event_value, reference_value, difference,
        'bridge' as kind,
        run_id
    from bridge_rows
    where rn = 1
)

select
    n.kind,
    n.subject,
    n.block_number,
    n.passed,
    n.checked_at,
    n.event_value,
    n.reference_value,
    n.difference,
    n.run_id,
    r.run_id as latest_run_id,
    r.scope as latest_run_scope,
    r.status as latest_run_status,
    r.finished_at as latest_run_finished_at,
    case when n.kind = 'bridge' then coalesce(n.run_id = r.run_id, false) end as in_latest_run
from newest as n
left join latest_run as r on true
