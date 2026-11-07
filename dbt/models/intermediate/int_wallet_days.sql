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
    select chain, day_utc from {{ ref('int_chain_days') }}
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
