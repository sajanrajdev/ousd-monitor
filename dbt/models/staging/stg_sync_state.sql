select
    chain,
    synced_through
from {{ source('raw', 'sync_state') }}
