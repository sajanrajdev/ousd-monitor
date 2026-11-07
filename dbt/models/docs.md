{% docs base_units %}
An amount in base units: OUSD has 6 decimals, so 1000000 is $1 and 1000000000000 is $1M. Amounts are
HUGEINT integers and never floats, so sums stay exact to the base unit.
{% enddocs %}

{% docs bps %}
A share or rate in basis points: an integer where 1 bp is 0.01% and 10000 is 100%. Shares come from
floor division, so a set of them sums to at most 10000.
{% enddocs %}

{% docs utc_day %}
A calendar day in UTC. Every day boundary in the project is UTC, whatever the chain's own clock.
{% enddocs %}

{% docs chain %}
The chain the row is about: tempo, ethereum, base or solana. Chains are always told apart by their
OUSD contract address, as the ticker also belongs to another token.
{% enddocs %}

{% docs run_id %}
The identifier of one pipeline run, shared by the checks and comparisons that run recorded.
{% enddocs %}
