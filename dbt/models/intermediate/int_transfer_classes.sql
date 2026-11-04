with ordered as (
    select
        *,
        row_number() over (partition by chain, tx_hash order by log_index desc) as rn_desc
    from {{ ref('stg_transfers') }}
)

select
    t.chain,
    t.block_number,
    t.log_index,
    t.day_utc,
    t.tx_hash,
    t.from_address,
    t.to_address,
    t.value,
    case
        when t.from_address = '{{ var("zero_address") }}' then 'mint'
        when t.to_address = '{{ var("zero_address") }}' then 'burn'
        when
            t.chain = 'tempo' and t.to_address = '{{ var("tempo_fee_manager") }}' and t.rn_desc = 1
            then 'fee'
        when
            t.chain = 'tempo' and '{{ var("tempo_fee_manager") }}' in (t.from_address, t.to_address)
            then 'fee_liquidity'
        when
            lf.category in ('issuer', 'issuer_route') or lt.category in ('issuer', 'issuer_route')
            then 'issuer_flow'
        when lf.entity = lt.entity then 'same_entity'
        else 'remaining'
    end as transfer_class
from ordered as t
left join {{ ref('stg_labels') }} as lf on lf.chain = t.chain and lf.address = t.from_address
left join {{ ref('stg_labels') }} as lt on lt.chain = t.chain and lt.address = t.to_address
