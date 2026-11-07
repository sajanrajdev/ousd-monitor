select
    p.chain,
    p.day_utc,
    l.entity,
    cast(sum(p.close_balance) as hugeint) as balance,
    count(*) as wallets
from {{ ref('int_wallet_placed') }} as p
inner join {{ ref('stg_labels') }} as l on l.chain = p.chain and l.address = p.address
where p.category = 'exchange' and p.close_balance > 0 and l.entity is not null
group by p.chain, p.day_utc, l.entity
