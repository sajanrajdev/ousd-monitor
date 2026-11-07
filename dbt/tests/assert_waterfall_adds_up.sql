select chain, day_utc
from {{ ref('mart_activity_waterfall') }}
where
    headline_value <> minted + burned + fees + fee_liquidity + issuer_flows + same_entity
    + same_tx_netting + dex_flow + lending_flow + clean_large + clean_everyday
