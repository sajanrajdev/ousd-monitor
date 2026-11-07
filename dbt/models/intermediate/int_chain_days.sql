-- One row per chain per UTC day, from the chain's first day with any wallet movement through its
-- last complete day. Every activity mart is driven from this calendar, so a day with no
-- transfers is a row of zeros and not a missing day.
select
    c.chain,
    cast(unnest(generate_series(min(e.day_utc), c.last_complete_day, interval 1 day)) as date)
        as day_utc
from {{ ref('int_wallet_events') }} as e
inner join {{ ref('stg_sync_coverage') }} as c on c.chain = e.chain
group by c.chain, c.last_complete_day
