-- A left join keeps a chain that has a sync cursor but no transfers yet. Its last complete day is
-- empty, so the calendar in int_chain_days, which needs wallet movement, still has no days for it.
select
    s.chain,
    s.synced_through,
    max(t.block_timestamp) as last_transfer_timestamp,
    cast(to_timestamp(max(t.block_timestamp)) at time zone 'UTC' as date) - 1 as last_complete_day
from {{ ref('stg_sync_state') }} as s
left join {{ ref('stg_transfers') }} as t on t.chain = s.chain
group by s.chain, s.synced_through
