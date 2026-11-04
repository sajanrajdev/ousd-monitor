with gross as (
    select chain, tx_hash, cast(sum(value) as hugeint) as gross_value, min(day_utc) as day_utc
    from {{ ref('int_transfer_classes') }}
    where transfer_class = 'remaining'
    group by chain, tx_hash
),

nets as (
    select
        chain,
        tx_hash,
        coalesce(sum(net_value) filter (where net_value > 0), 0) as moved,
        greatest(
            coalesce(sum(net_value) filter (where net_value > 0 and category = 'dex'), 0),
            coalesce(-sum(net_value) filter (where net_value < 0 and category = 'dex'), 0)
        ) as dex_raw,
        greatest(
            coalesce(sum(net_value) filter (where net_value > 0 and category = 'lending'), 0),
            coalesce(-sum(net_value) filter (where net_value < 0 and category = 'lending'), 0)
        ) as lending_raw
    from {{ ref('int_tx_net') }}
    group by chain, tx_hash
),

parts as (
    select
        g.chain,
        g.tx_hash,
        g.day_utc,
        g.gross_value,
        n.moved,
        g.gross_value - n.moved as same_tx_netting,
        least(n.moved, n.dex_raw) as dex_flow,
        least(n.moved - least(n.moved, n.dex_raw), n.lending_raw) as lending_flow
    from gross as g
    inner join nets as n on n.chain = g.chain and n.tx_hash = g.tx_hash
)

select
    chain,
    tx_hash,
    day_utc,
    cast(gross_value as hugeint) as gross_value,
    cast(same_tx_netting as hugeint) as same_tx_netting,
    cast(dex_flow as hugeint) as dex_flow,
    cast(lending_flow as hugeint) as lending_flow,
    cast(moved - dex_flow - lending_flow as hugeint) as clean_value
from parts
