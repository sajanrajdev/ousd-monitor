select
    s.chain,
    s.synced_through,
    max(t.block_timestamp) as last_transfer_timestamp,
    cast(to_timestamp(max(t.block_timestamp)) at time zone 'UTC' as date) - 1 as last_complete_day
from {{ source('raw', 'sync_state') }} as s
inner join {{ ref('stg_transfers') }} as t on t.chain = s.chain
group by s.chain, s.synced_through
