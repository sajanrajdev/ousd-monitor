-- The waterfall has exactly the rows of the shared calendar. The KPI mart has exactly the rows of
-- the supply journey, with no missing day between its first and last.
with calendar_diff as (
    select 'waterfall_missing' as problem, chain, day_utc
    from (
        select chain, day_utc from {{ ref('int_chain_days') }}
        except
        select chain, day_utc from {{ ref('mart_activity_waterfall') }}
    )
    union all
    select 'waterfall_extra' as problem, chain, day_utc
    from (
        select chain, day_utc from {{ ref('mart_activity_waterfall') }}
        except
        select chain, day_utc from {{ ref('int_chain_days') }}
    )
),

journey_diff as (
    select 'kpis_missing' as problem, chain, day_utc
    from (
        select chain, day_utc from {{ ref('mart_supply_journey') }}
        except
        select chain, day_utc from {{ ref('mart_activity_kpis') }}
    )
    union all
    select 'kpis_extra' as problem, chain, day_utc
    from (
        select chain, day_utc from {{ ref('mart_activity_kpis') }}
        except
        select chain, day_utc from {{ ref('mart_supply_journey') }}
    )
),

kpi_spans as (
    select chain, min(day_utc) as first_day, max(day_utc) as last_day, count(*) as days_present
    from {{ ref('mart_activity_kpis') }}
    group by chain
)

select problem, chain, day_utc from calendar_diff
union all
select problem, chain, day_utc from journey_diff
union all
select 'kpis_gap' as problem, chain, first_day as day_utc
from kpi_spans
where days_present <> last_day - first_day + 1
