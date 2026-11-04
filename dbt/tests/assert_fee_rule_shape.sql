-- The largest real fee seen is 1.07 OUSD.
-- A fee above 10 OUSD means the rule has caught a real transfer.
select chain, tx_hash, value
from {{ ref('int_transfer_classes') }}
where transfer_class = 'fee' and value > 10000000
