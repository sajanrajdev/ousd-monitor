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
        day_utc - min(day_utc) over (partition by chain) >= 6 as has_full_window
    from {{ ref('mart_activity_waterfall') }}
    -- A calendar range, so a day with no transfers counts as a day with no volume.
    window w as (
        partition by chain order by day_utc
        range between interval 6 days preceding and current row
    )
),

senders as (
    select n.chain, n.day_utc, n.address, -n.net_value as sent
    from {{ ref('int_tx_net') }} as n
    inner join {{ ref('int_tx_decomposition') }} as d on d.chain = n.chain and d.tx_hash = n.tx_hash
    where
        n.net_value < 0
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
        count(*) filter (where sent_7d >= {{ var("active_secondary_base_units") }})
            as active_wallets_over_100_7d
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
    case
        when
            r.has_full_window and j.circulating_supply > 0
            then cast(r.clean_7d * 10000 // (7 * j.circulating_supply) as integer)
    end as velocity_bps,
    case
        when
            r.has_full_window and j.circulating_supply > 0
            then cast(r.clean_everyday_7d * 10000 // (7 * j.circulating_supply) as integer)
    end as velocity_everyday_bps,
    case
        when
            r.has_full_window and j.total_supply > 0
            then cast(r.headline_7d * 10000 // (7 * j.total_supply) as integer)
    end as headline_velocity_bps,
    coalesce(a.active_wallets_7d, 0) as active_wallets_7d,
    coalesce(a.active_wallets_over_100_7d, 0) as active_wallets_over_100_7d
from journey as j
inner join rolled as r on r.chain = j.chain and r.day_utc = j.day_utc
left join active_counts as a on a.chain = j.chain and a.day_utc = j.day_utc
