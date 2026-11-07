select chain, day_utc
from {{ ref('mart_supply_journey') }}
where
    total_supply
    <> issuer_inventory + placed_supply + venue_dex + venue_lending + venue_exchange + free_floating
