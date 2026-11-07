-- mart_build_params is read as the one record of a build's thresholds, so it has exactly one row.
select count(*) as n
from {{ ref('mart_build_params') }}
having count(*) <> 1
