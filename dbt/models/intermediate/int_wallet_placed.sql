{% set n = var("placed_days") | int %}

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
    w_full as (
        partition by d.chain, d.address
        order by d.day_utc rows between {{ n }} preceding and current row
    ),
    w_after as (
        partition by d.chain, d.address
        order by d.day_utc rows between {{ n - 1 }} preceding and current row
    )
