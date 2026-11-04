select chain, block_number, log_index, count(*) as n
from {{ ref('stg_transfers') }}
group by chain, block_number, log_index
having count(*) > 1
