-- mart_build_params casts each base-unit threshold to a whole number, while the models compare
-- against the var as given. A fractional var would make the two differ, so it fails the build.
{% set names = [
    "placed_min_base_units",
    "large_transfer_base_units",
    "clean_tx_min_base_units",
    "active_dust_base_units",
    "active_secondary_base_units",
] %}
{% for name in names %}
    select '{{ name }}' as threshold
    where {{ var(name) }} <> cast({{ var(name) }} as hugeint)
    {% if not loop.last %}union all{% endif %}
{% endfor %}
