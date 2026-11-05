{% set min_value = var("placed_min_base_units") %}

with wallets as (
    select
        chain,
        day_utc,
        address,
        close_balance,
        category,
        case
            when
                (category is null or category = 'exchange_linked')
                and still_value >= {{ min_value }}
                then still_value
            else 0
        end as placed_part
    from {{ ref('int_wallet_placed') }}
),

ranked as (
    select
        *,
        row_number()
            over (partition by chain, day_utc order by close_balance desc, address asc)
            as balance_rank
    from wallets
    where close_balance > 0
),

issuer_coverage as (
    select chain, true as issuer_labeled
    from {{ ref('stg_labels') }}
    where category in ('issuer', 'issuer_route')
    group by chain
)

select
    r.chain,
    r.day_utc,
    cast(sum(r.close_balance) as hugeint) as total_supply,
    cast(
        coalesce(
            sum(r.close_balance) filter (where r.category in ('issuer', 'issuer_route')), 0
        ) as hugeint
    ) as issuer_inventory,
    cast(sum(r.placed_part) as hugeint) as placed_supply,
    cast(coalesce(sum(r.placed_part) filter (where r.category = 'exchange_linked'), 0) as hugeint)
        as placed_exchange_linked,
    cast(coalesce(sum(r.close_balance) filter (where r.category = 'dex'), 0) as hugeint)
        as venue_dex,
    cast(coalesce(sum(r.close_balance) filter (where r.category = 'lending'), 0) as hugeint)
        as venue_lending,
    cast(coalesce(sum(r.close_balance) filter (where r.category = 'exchange'), 0) as hugeint)
        as venue_exchange,
    cast(
        coalesce(
            sum(r.close_balance - r.placed_part) filter (
                where r.category is null or r.category in ('system', 'exchange_linked')
            ),
            0
        ) as hugeint
    ) as free_floating,
    count(*) filter (where r.placed_part > 0) as placed_wallets,
    count(*) as holders,
    count(*) filter (where r.close_balance >= {{ min_value }}) as holders_over_1m,
    cast(sum(r.close_balance) filter (where r.balance_rank <= 10) as hugeint) as top10_value,
    coalesce(max(c.issuer_labeled), false) as issuer_labeled
from ranked as r
left join issuer_coverage as c on c.chain = r.chain
group by r.chain, r.day_utc
