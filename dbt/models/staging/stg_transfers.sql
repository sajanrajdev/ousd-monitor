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
