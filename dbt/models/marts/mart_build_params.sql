-- The thresholds this build used, as one row. Each is rendered exactly as the models that apply it
-- render it, so the blocking checks and publish can read what a build used without parsing those
-- models' SQL. It selects no data, so its compiled SQL alone gives the same row.
select
    cast({{ var("placed_days") | int }} as integer) as placed_days,
    cast({{ var("placed_min_base_units") }} as hugeint) as placed_min_base_units,
    cast({{ var("large_transfer_base_units") }} as hugeint) as large_transfer_base_units,
    cast({{ var("clean_tx_min_base_units") }} as hugeint) as clean_tx_min_base_units,
    cast({{ var("active_dust_base_units") }} as hugeint) as active_dust_base_units,
    cast({{ var("active_secondary_base_units") }} as hugeint) as active_secondary_base_units
