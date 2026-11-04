with legs as (
    select chain, tx_hash, day_utc, to_address as address, value as delta
    from {{ ref('int_transfer_classes') }}
    where transfer_class = 'remaining'
    union all
    select chain, tx_hash, day_utc, from_address as address, -value as delta
    from {{ ref('int_transfer_classes') }}
    where transfer_class = 'remaining'
)

select
    l.chain,
    l.tx_hash,
    l.address,
    cast(sum(l.delta) as hugeint) as net_value,
    min(l.day_utc) as day_utc,
    any_value(lb.category) as category
from legs as l
left join {{ ref('stg_labels') }} as lb on lb.chain = l.chain and lb.address = l.address
group by l.chain, l.tx_hash, l.address
