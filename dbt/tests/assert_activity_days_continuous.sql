-- Every chain has a row for each UTC day between its first and last day in both activity marts,
-- and the two marts cover the same range of days.
with marts as (
    select 'mart_activity_waterfall' as model, chain, day_utc
    from {{ ref('mart_activity_waterfall') }}
    union all
    select 'mart_activity_kpis' as model, chain, day_utc
    from {{ ref('mart_activity_kpis') }}
),

spans as (
    select
        model,
        chain,
        min(day_utc) as first_day,
        max(day_utc) as last_day,
        count(distinct day_utc) as days_present
    from marts
    group by model, chain
)

select chain, model, first_day, last_day
from spans
where days_present <> last_day - first_day + 1
union all
select
    chain,
    'range_mismatch' as model,
    min(first_day) as first_day,
    max(last_day) as last_day
from spans
group by chain
having count(distinct first_day) > 1 or count(distinct last_day) > 1 or count(*) <> 2
