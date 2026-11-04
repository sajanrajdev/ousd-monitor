{% set large = var("large_transfer_base_units") %}

with rows_part as (
    select
        chain,
        day_utc,
        cast(sum(value) as hugeint) as headline_value,
        cast(coalesce(sum(value) filter (where transfer_class = 'mint'), 0) as hugeint) as minted,
        cast(coalesce(sum(value) filter (where transfer_class = 'burn'), 0) as hugeint) as burned,
        cast(coalesce(sum(value) filter (where transfer_class = 'fee'), 0) as hugeint) as fees,
        cast(coalesce(sum(value) filter (where transfer_class = 'fee_liquidity'), 0) as hugeint)
            as fee_liquidity,
        cast(coalesce(sum(value) filter (where transfer_class = 'issuer_flow'), 0) as hugeint)
            as issuer_flows,
        cast(coalesce(sum(value) filter (where transfer_class = 'same_entity'), 0) as hugeint)
            as same_entity,
        count(*) as transfer_count,
        count(*) filter (where transfer_class = 'fee') as fee_count
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
        cast(coalesce(sum(clean_value) filter (where clean_value >= {{ large }}), 0) as hugeint)
            as clean_large,
        cast(coalesce(sum(clean_value) filter (where clean_value < {{ large }}), 0) as hugeint)
            as clean_everyday,
        count(*) filter (where clean_value >= {{ var("clean_tx_min_base_units") }})
            as clean_tx_count
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
