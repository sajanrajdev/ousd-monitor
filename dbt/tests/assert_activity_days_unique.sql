select 'mart_activity_waterfall' as model, chain, day_utc
from {{ ref('mart_activity_waterfall') }}
group by chain, day_utc
having count(*) > 1
union all
select 'mart_activity_kpis' as model, chain, day_utc
from {{ ref('mart_activity_kpis') }}
group by chain, day_utc
having count(*) > 1
