with legs as (
    select chain, to_address as address, block_number, log_index, 1 as side, day_utc, value as delta
    from {{ ref('stg_transfers') }}
    union all
    select
        chain, from_address as address, block_number, log_index, 0 as side, day_utc, -value as delta
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
