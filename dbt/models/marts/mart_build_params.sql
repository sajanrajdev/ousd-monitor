-- The thresholds this build used, as one row, with the dbt invocation that built it. Each is
-- rendered exactly as the models that apply it render it, so the blocking checks and publish can
-- read what a build used without parsing those models' SQL. The invocation id matches the one in
-- that build's run_results.json, which shows the marts came from the build that record describes.
select
    '{{ invocation_id }}' as invocation_id,
    cast({{ var("placed_days") | int }} as integer) as placed_days,
    cast({{ var("placed_min_base_units") }} as hugeint) as placed_min_base_units,
    cast({{ var("large_transfer_base_units") }} as hugeint) as large_transfer_base_units,
    cast({{ var("clean_tx_min_base_units") }} as hugeint) as clean_tx_min_base_units,
    cast({{ var("active_dust_base_units") }} as hugeint) as active_dust_base_units,
    cast({{ var("active_secondary_base_units") }} as hugeint) as active_secondary_base_units
