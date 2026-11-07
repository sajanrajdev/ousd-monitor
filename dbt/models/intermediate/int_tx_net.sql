with legs as (
    select chain, tx_hash, day_utc, to_address as address, value as delta
    from {{ ref('int_transfer_classes') }}
    where transfer_class = 'remaining'
    union all
    select chain, tx_hash, day_utc, from_address as address, -value as delta
    from {{ ref('int_transfer_classes') }}
    where transfer_class = 'remaining'
)

-- The category is grouped on, not picked: a label is unique per chain and address
-- (assert_unique_label), so every leg of one address carries the same category, and grouping keeps
-- one row per address. A label duplicated with two categories would show as two rows here, not as
-- an arbitrary pick of one.
select
    l.chain,
    l.tx_hash,
    l.address,
    lb.category,
    cast(sum(l.delta) as hugeint) as net_value,
    min(l.day_utc) as day_utc
from legs as l
left join {{ ref('stg_labels') }} as lb on lb.chain = l.chain and lb.address = l.address
group by l.chain, l.tx_hash, l.address, lb.category
