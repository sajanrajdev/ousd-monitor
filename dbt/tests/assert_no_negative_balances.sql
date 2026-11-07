select chain, address, min(running_balance) as lowest
from {{ ref('int_wallet_events') }}
group by chain, address
having min(running_balance) < 0
