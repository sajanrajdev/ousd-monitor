# Exchange holdings of Open USD: findings

The research behind the exchange-linked band in [the methodology](../methodology.md#exchange-linked-placed). All checks ran on 2026-11-04. Published figures and flows are for the UTC day 2026-11-03, and share figures are floored to two decimals, as the verdict floors them.

This page gives totals by tier and leaves out wallet-by-wallet tables, so it ties no unnamed wallet to an exchange. A wallet that no public source names stays unnamed. Figures for sets that aren't published are rounded.

## Summary

| Question | Answer |
|---|---|
| Which exchanges support OUSD? | Coinbase and Kraken are the two that official sources confirm. Coinbase lists all four chains by contract address. Kraken shows Tempo, and its other chains are unknown. No other exchange we could read has an Open USD market on its public API. That is strong evidence on spot trading and says nothing about custody or apps |
| How much is admissibly labeled? | $346,579.21 in 7 Coinbase wallets, 0.03% of supply. No public source names a Kraken wallet that holds OUSD |
| How much of placed moves? | None. The named wallets are hot wallets under the $1M placed floor, so placed stays 684.70M, 77.07% of 888.33M |
| Does "at least half is sitting still" hold? | Yes, as a finding. As a sensitivity it holds at 57.09% with tier 1 moved, and at about 54% with tier 2 added. It falls to about 45% only with the weaker tier 3 added |
| Is exchange-held OUSD idle? | It doesn't move on the chain, and the chain can't show use inside an exchange. Neither "idle" nor "in use" is established |

## Sensitivity of the headline

Tiers rank how strongly a wallet looks like exchange custody. Tier 1 holds 177.51M, tier 2 about 25M and tier 3 about 85M. None is a named wallet, so none is counted as an exchange. They show how much the headline depends on the question.

Placed stays over 50% unless more than 240.54M moves out of it.

| Scenario | Placed after the move | Share |
|---|---|---|
| Published and admissible: nothing moves | 684.70M | 77.07% |
| Tier 1 moved | 507.19M | 57.09% |
| Tiers 1 and 2 moved | about 480M | about 54% |
| Tiers 1, 2 and 3 moved | about 400M | about 45% |

- The verdict would read "Mixed" only in the last row, since everyday volume is 3.61% of supply, under the 5% needed for "Moving".
- The question matters much more outside Tempo. Tier 1 alone takes Ethereum, Base and Solana under 50% of their own placed share.
- Moving a wallet to a venue label lowers placed, but its balance is no less still. What changes is whether stillness says anything about use.
- Velocity would shift a lot, because moving placed into a venue raises circulating supply, the denominator. Across chains, circulating goes from 164.16M to 341.68M if tier 1 moved. Ethereum velocity would fall from 88.22% to 3.03% a day.

## Is it idle?

On the chain, these balances don't move. Tiers 1 and 2 turned over 0.01% in 7 days and 0.02% in 14 days, against 16.50% and 17.61% for the other placed wallets. Of the 47 wallets in tiers 1 and 2, 45 had no transfer in either window. Their 30-day turnover is almost all one day, October 5, and says nothing about use since.

The named hot wallets do move money, but little, against tiny balances. Gross flow in the last 7 days was $134,243.72. Visible exchange trading looks thin: Kraken's ticker showed 14.02 OUSD traded in 24 hours, and Coinbase Exchange has no public OUSD book. That is one reading on one day.

What the chain can't show:

- Anything inside an exchange's own ledger: trading between its clients, client balances, rewards, lending or treasury use. A wallet that never moves can back heavy internal activity, or none at all.
- Who owns a custody wallet. It could be the exchange, or a client of its custody business, which mean different things for "in use".
- Rewards for holding. A balance can earn its holder money without moving. That is a reason to hold, and doesn't show demand from anyone else.

**Result: neither view is established.** The chain gives no sign of use for these balances, and it can't see where use would happen. So "idle" overclaims, and "in use" has no evidence behind it. The accurate wording is that the balances haven't moved on the chain, and that use inside an exchange, if any, can't be seen.

## Source conflicts, left as found

- Coinbase's asset pages say OUSD is available on its centralized exchange, but its Exchange product list has no OUSD product among 845, and the public Advanced Trade lookup for OUSD-USD returned none. With `convertible_to: USD`, this may be conversion rather than a book. That is a reading, not a fact.
- Kraken's price page says 622,939 OUSD traded on Kraken in 24 hours. Its own ticker API showed 14.02 OUSD and 2 trades in the rolling 24 hours when read. The page figure is close to the market-wide figure, but we can't say why they differ. The order book did show real size: 555,050 bid at 0.9998 and 410,000 offered at 1.0000.

## Labelling decisions

- Zero Hash is named but not counted as an exchange (counting it would add $25,013.00).
- A name from an EVM address list on a Tempo wallet isn't counted, since no source ties it to Tempo.
- A public address compilation is a lead for finding wallets, not a naming source for new rows. It matched only Coinbase, Zero Hash and one other firm among all OUSD addresses.
- Label sites, such as Arkham and DeBank, are leads, not naming sources, because the source list in [the PRD](../PRD.md) doesn't include them. Accepting them would lower placed. A wallet's funding is inference, so it isn't a name either.
- Solana wallets that Solscan tags as a Coinbase hot wallet count as `explorer_tag` with high confidence. They add $39,987.00 to exchange venues.
- The outflow allowance in the exchange-linked rule is 2% of inflows. With none, tier 1 would fall by about a quarter.

## Presentation

The page shows named exchanges as a stated floor, and an unnamed "exchange-linked" band inside placed, found by a written rule and named after no one. Thresholds and circulating supply stay as they are, and one guard is added to the verdict. Moving custody out of placed was rejected: it would treat inference as a source, and the headline would fall to 57.09% and rise again if a wallet proved to be a client's. The wording as built is in [the methodology](../methodology.md#exchange-linked-placed).
