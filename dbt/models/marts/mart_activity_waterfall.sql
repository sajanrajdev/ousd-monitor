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
    d.chain,
    d.day_utc,
    cast(coalesce(r.headline_value, 0) as hugeint) as headline_value,
    cast(coalesce(r.minted, 0) as hugeint) as minted,
    cast(coalesce(r.burned, 0) as hugeint) as burned,
    cast(coalesce(r.fees, 0) as hugeint) as fees,
    cast(coalesce(r.fee_liquidity, 0) as hugeint) as fee_liquidity,
    cast(coalesce(r.issuer_flows, 0) as hugeint) as issuer_flows,
    cast(coalesce(r.same_entity, 0) as hugeint) as same_entity,
    cast(coalesce(r.transfer_count, 0) as bigint) as transfer_count,
    cast(coalesce(r.fee_count, 0) as bigint) as fee_count,
    cast(coalesce(x.same_tx_netting, 0) as hugeint) as same_tx_netting,
    cast(coalesce(x.dex_flow, 0) as hugeint) as dex_flow,
    cast(coalesce(x.lending_flow, 0) as hugeint) as lending_flow,
    cast(coalesce(x.clean_large, 0) as hugeint) as clean_large,
    cast(coalesce(x.clean_everyday, 0) as hugeint) as clean_everyday,
    cast(coalesce(x.clean_tx_count, 0) as bigint) as clean_tx_count
from {{ ref('int_chain_days') }} as d
left join rows_part as r on r.chain = d.chain and r.day_utc = d.day_utc
left join tx_part as x on x.chain = d.chain and x.day_utc = d.day_utc
