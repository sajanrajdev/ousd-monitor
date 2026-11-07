select
    chain,
    address,
    category,
    source_type,
    source_url,
    confidence,
    cast(date_checked as date) as date_checked,
    nullif(entity, '') as entity
from {{ source('labels', 'labels') }}
