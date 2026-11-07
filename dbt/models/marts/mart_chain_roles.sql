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
    cast(j.total_supply * 10000 // nullif(sum(j.total_supply) over (), 0) as integer)
        as supply_share_bps,
    cast(j.placed_supply * 10000 // nullif(j.total_supply, 0) as integer)
        as placed_share_of_chain_bps,
    cast(coalesce(a.minted_30d, 0) as hugeint) as minted_30d,
    cast(coalesce(a.burned_30d, 0) as hugeint) as burned_30d,
    cast(coalesce(a.dex_flow_30d, 0) as hugeint) as dex_flow_30d,
    cast(coalesce(a.lending_flow_30d, 0) as hugeint) as lending_flow_30d,
    cast(coalesce(a.clean_30d, 0) as hugeint) as clean_30d,
    cast(coalesce(a.clean_everyday_30d, 0) as hugeint) as clean_everyday_30d,
    cast(
        coalesce(a.clean_everyday_30d, 0) * 10000
        // nullif(sum(coalesce(a.clean_everyday_30d, 0)) over (), 0) as integer
    ) as clean_everyday_share_bps,
    cast(
        coalesce(a.dex_flow_30d, 0) * 10000
        // nullif(sum(coalesce(a.dex_flow_30d, 0)) over (), 0) as integer
    ) as dex_flow_share_bps
from journey as j
left join activity as a on a.chain = j.chain
