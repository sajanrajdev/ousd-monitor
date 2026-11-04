select chain, address, count(*) as n
from {{ ref('stg_labels') }}
group by chain, address
having count(*) > 1
