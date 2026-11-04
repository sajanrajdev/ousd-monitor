with events as (
    select
        chain,
        day_utc,
        sum(
            sum(case when from_address = '{{ var("zero_address") }}' then value else 0 end)
            - sum(case when to_address = '{{ var("zero_address") }}' then value else 0 end))
            over (partition by chain order by day_utc rows unbounded preceding) as supply
    from {{ ref('stg_transfers') }}
    group by chain, day_utc
)

select j.chain, j.day_utc
from {{ ref('mart_supply_journey') }} as j
inner join events as e on e.chain = j.chain and e.day_utc = j.day_utc
where j.total_supply <> e.supply
