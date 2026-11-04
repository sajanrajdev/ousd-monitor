select chain, day_utc
from {{ ref('mart_supply_journey') }}
group by chain, day_utc
having count(*) > 1
