# Exchange holdings of Open USD: findings

The research behind the exchange-linked change. Linear: ORC-100. All checks ran on 2026-11-04.

This version leaves out the wallet-by-wallet candidate tables, so that this repository doesn't tie an unnamed wallet to an exchange. A wallet on the list isn't named by a public source, so the doc gives totals by tier, and `labels/labels.csv` lists the tier 1 addresses without a name. Figures for sets that aren't published are rounded, and flows are left out where an exact amount could be matched to a wallet.

## Summary

The maintainer's view is that OUSD at a centralized exchange isn't idle. The data can't confirm or reject that. It does settle how much of today's headline depends on it.

| Question | Answer |
|---|---|
| Which exchanges support OUSD? | **Coinbase and Kraken** are the two that official sources confirm. Open Standard names both as the first centralized venues. Coinbase lists all four chains by contract address. Kraken shows Tempo, and its other chains are unknown. No other exchange we could read has an Open USD market on its public API. That is strong evidence on spot trading and says nothing about custody or apps |
| How much is admissibly labeled? | **$346,579.21 in 7 Coinbase wallets**, 0.03% of supply. That is the published $306.6K plus $39,987.00 in four Solana wallets that Solscan names. We found no public source naming a Kraken wallet that holds OUSD |
| How much of placed moves? | **None, $0.** The named wallets are hot wallets under the $1M placed floor. Placed stays 684.70M, 77.07% of 888.33M |
| Does "at least half is sitting still" hold? | **Yes, as a finding.** As a sensitivity, not a finding, it holds at 57.09% with tier 1 (177.51M) moved and about 54% with tier 2 (about 25M) added. It falls to about 45% only with the weak tier 3 (about 85M) added. The break-even is 240.54M moved out of placed |
| Is exchange-held OUSD idle? | **On the chain, it doesn't move.** Tiers 1 and 2 turned over 0.01% in 7 days and 0.02% in 14 days, less than the other placed wallets at 16.50% and 17.61%. Use inside an exchange's own ledger can't be seen from the chain, so this doesn't show the money is unused |
| Presentation pick | **Option B:** keep named exchange rows as a stated floor, and show an unnamed "exchange-linked" band inside placed, found by a written rule. Thresholds and circulating supply stay as they are, and one guard is added to the verdict |

Dates: the published figures and all flows are for the UTC day 2026-11-03. "OUSD now" is a point read at 2026-11-04T19:40:34Z. Share figures are floored to two decimals, as the verdict floors them.

## Decision and later checks

**The maintainer chose option B on 2026-11-04.** The maintainer then opened the explorer and label-site pages, with these results:

| Page | What the maintainer saw | How it counts |
|---|---|---|
| Etherscan: four tier 1 wallets | Words naming an exchange's custody business | **Not a name for these wallets.** All four pages were re-read on 2026-11-04. None has a name tag on the address. The words appear only in the transaction list, as the sender of the wallet's ETH. Funding is inference, so they stay unnamed in tier 1 |
| Arkham: three tier 1 wallets | Names for an exchange | A lead |
| DeBank: one tier 1 wallet | A name for an exchange, reported as confirmed | A lead |

These don't change a label, because the PRD's source list doesn't include label sites. Two label sites together also remain leads. **The maintainer decided on 2026-11-04 not to accept Arkham and DeBank as naming sources.** Accepting them would have lowered placed.

**How option B was built, where it differs from section 6:**

- The maintainer later allowed exchange names on the main page, so per-exchange rows are on the main page as well as the methodology page, each beside its source. `verify-output` allows no other labeled name there, and no wallet in the band is named.
- The allowance in the rule is written into the definition: at most 2% of inflows sent anywhere else.
- The verdict's sentence now says "wallets of $1M or more with no issuer, venue or system label" rather than "unlabeled wallets", because exchange-linked wallets carry a category. The insight models plan keeps the earlier wording as its record.
- A second guard covers the two doubts together: exchange-linked placed plus the placed supply of a chain with no issuer label. It doesn't fire today, at 56.76%.
- The published dataset's `schema_version` goes from 1 to 2, because the new required fields are a breaking change. A dataset published before this needs a new publish before a site can be built from it.

## 1. Which exchanges support it

Matched by contract address or by an explicit statement that it is Open USD. "No market" means the exchange's own public market API returned no Open USD instrument on 2026-11-04. It doesn't rule out custody, an app-only product or a later listing.

| Exchange | Status | Chains | Services found | Services not determined | Evidence |
|---|---|---|---|---|---|
| **Coinbase** | Supported, matched by contract address on all four chains | Base, Ethereum, Solana, Tempo, all `online` | Deposits and withdrawals on each network, 4,000,000 maximum withdrawal in the API. Retail buy, per its asset page. Mint and redeem from October 1, per Open Standard. Conversion to USD, as the API lists `convertible_to: USD` | Rewards or earn. Custody asset list. Why there is no order book, see below | [Currency API](https://api.exchange.coinbase.com/currencies/OUSD), [asset page](https://www.coinbase.com/price/ousd), [how to buy](https://www.coinbase.com/how-to-buy/ousd), [Open Standard launch post](https://joinopenstandard.com/blog/ousd-is-live/) |
| **Kraken** | Supported, by an explicit statement that it is Open USD | Tempo confirmed. Others unknown | Spot OUSD/USD, live since 2026-09-30, and the only OUSD pair in its API. Funding. Kraken Prime custody lists OUSD | Which other chains. Rewards: its page says only "See if you can earn rewards". App and Instant Buy depended on liquidity conditions | [Listing post](https://blog.kraken.com/product/asset-listings/ousd-is-available-for-trading), [Pair API](https://api.kraken.com/0/public/AssetPairs?pair=OUSDUSD), [status page](https://status.kraken.com/), [Prime assets](https://www.kraken.com/prime/custody/supported-assets) |
| Binance, Binance.US | No market. `Invalid symbol` | None found | None. Its [Binance Wallet token page](https://web3.binance.com/en-IN/token/eth/0x9f6f3991d525015a6f8caf062c83b62fd3ac4436) isn't an exchange listing | Custody or private products | [API](https://api.binance.com/api/v3/exchangeInfo?symbol=OUSDUSDT) |
| OKX | No market. A named partner | None found | None. The June 18 [X-Perp notice](https://www.okx.com/help/okx-to-list-ousd-expiry-perp-x-perp) predates the June 30 announcement and doesn't mention Open USD, so it isn't counted | What "OUSD UM" refers to. App or custody | [Spot API](https://www.okx.com/api/v5/public/instruments?instType=SPOT&instId=OUSD-USDT) |
| Bybit | No market. A named partner on Open Standard's site | None found | Its [price page](https://www.bybit.com/en/price/open-usd/) carries CoinGecko data, which isn't a listing | App or custody | [API](https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=OUSDUSDT) |
| Crypto.com, Gemini | No market. Named partners | None found | None | App or custody | [Crypto.com instruments](https://api.crypto.com/exchange/v1/public/get-instruments), [Gemini](https://api.gemini.com/v1/symbols/details/ousdusd) |
| **KuCoin** | **Not Open USD.** Its `OUSD` is Origin Dollar, contract `0x2a8e1e676ec238d8a992307b495b45b3feaa5e86`, deposits and withdrawals off | Not counted | | | [API](https://api.kucoin.com/api/v3/currencies/OUSD) |
| **Gate** | **Not counted.** Its `OUSD` has an invalid address placeholder, all services off, and a market cap of about $6.1M, so it doesn't match Open USD | Not counted | | Which token it was | [API](https://api.gateio.ws/api/v4/spot/currencies/OUSD) |
| Bitget, MEXC, HTX, Bitstamp, Upbit, Bithumb, Bitfinex, LBank, Bitvavo, Bullish, Bitso, WhiteBIT, Backpack, WOO X, Poloniex, Coinone, Korbit, bitFlyer, BingX, XT, Phemex, Bitrue | No market | None found | None | App or custody | Own public APIs, listed in the appendix |
| CoinEx, BitMart, AscendEX, Robinhood, eToro | **Unknown.** The API failed, refused or was unusable | Unknown | Unknown | Everything | Listed in the appendix |

**Is it only Coinbase?** No. Kraken is confirmed. Coinbase and Kraken are the only two confirmed, and "only these two" is well supported but not proven:

- Open Standard's launch post says "starting with Coinbase, Kraken, and Uniswap—with more to be added over time".
- [CoinGecko's tickers](https://api.coingecko.com/api/v3/coins/open-usd/tickers) show Kraken as the only centralized venue, and return nothing for Coinbase or Binance. [CoinMarketCap](https://coinmarketcap.com/currencies/open-usd/) lists 13 pairs, all on DEXs.
- A public compilation of about 5,000 EVM exchange addresses matched only Coinbase, Zero Hash and one other firm among all OUSD addresses. It holds more than 100 entries each for Binance, OKX and Kraken, and none of those sent or received OUSD on Ethereum, Base or Tempo through the backup.
- Being a partner isn't a listing. Open Standard's [site](https://joinopenstandard.com/) and [Eco's reading of its announcement](https://eco.com/support/en/articles/15704996-open-usd-partners-the-140-companies-behind-open-standard) name Bybit, OKX, Crypto.com, Gemini, eToro, Bitso and Dunamu, among others.

**Conflicts between official sources, left as found:**

- Coinbase's asset pages say OUSD is available on its "centralized exchange", but its [Exchange product list](https://api.exchange.coinbase.com/products) has no OUSD product among 845, and the public Advanced Trade lookup for OUSD-USD returned none. With `convertible_to: USD`, this may be conversion rather than a book. That is a reading, not a fact.
- Kraken's [support list of currencies and networks](https://support.kraken.com/articles/360000678446-cryptocurrencies-available-on-kraken), dated 2026-10-30, has no OUSD row, though its blog, API and status page all show it. A missing row on one page isn't evidence.
- Kraken's price page says 622,939 OUSD traded on Kraken in 24 hours. Its own [ticker API](https://api.kraken.com/0/public/Ticker?pair=OUSDUSD) showed 14.02 OUSD and 2 trades in the rolling 24 hours when read. The page figure is close to the market-wide figure, but we can't say why they differ. The [order book](https://api.kraken.com/0/public/Depth?pair=OUSDUSD&count=3) did show real size: 555,050 bid at 0.9998 and 410,000 offered at 1.0000.

## 2. Addresses a public source names

Seven wallets, all Coinbase. Each public source ties the name to this exact address. All balances are small, and none reaches the $1M placed floor.

| Chain | Address | Exchange | Wallet role, as the source states it | Source type | Source | Checked | Confidence | OUSD now | OUSD on 2026-11-03 | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| Ethereum | `0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43` | Coinbase | Exchange (tag "Coinbase 10") | `explorer_tag` | [link](https://etherscan.io/address/0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43) | 2026-11-04 | high | $215,946.24 | $215,946.24 | in labels.csv |
| Ethereum | `0xcd531ae9efcce479654c4926dec5f6209531ca7b` | Coinbase | Coinbase Prime (tag "Coinbase Prime 1") | `explorer_tag` | [link](https://etherscan.io/address/0xcd531ae9efcce479654c4926dec5f6209531ca7b) | 2026-11-04 | high | $45,010.00 | $45,010.00 | in labels.csv |
| Base | `0x20fe51a9229eef2cf8ad9e89d91cab9312cf3b7a` | Coinbase | Exchange (tag "Coinbase 14"; Basescan says the tag comes from a community compilation) | `explorer_tag` | [link](https://basescan.org/address/0x20fe51a9229eef2cf8ad9e89d91cab9312cf3b7a) | 2026-11-04 | medium | $45,635.97 | $45,635.97 | in labels.csv |
| Solana | `9obNtb5GyUegcs3a1CbBkLuc5hEWynWfJC6gjz5uWQkE` | Coinbase | Exchange (public name "Coinbase 4", tag "Coinbase Exchange: Hot Wallet", tags #Coinbase Exchange and #Exchange Wallet) | `explorer_tag` | [link](https://solscan.io/account/9obNtb5GyUegcs3a1CbBkLuc5hEWynWfJC6gjz5uWQkE) | 2026-11-04 | high | $3,249.05 | $3,249.05 | new |
| Solana | `FpwQQhQQoEaVu3WU2qZMfF1hx48YyfwsLoRgXG83E99Q` | Coinbase | Hot (public name "Coinbase Hot Wallet 1", tag "Coinbase Exchange: Hot Wallet", tags #Coinbase Exchange and #Exchange Wallet) | `explorer_tag` | [link](https://solscan.io/account/FpwQQhQQoEaVu3WU2qZMfF1hx48YyfwsLoRgXG83E99Q) | 2026-11-04 | high | $14,185.40 | $14,185.40 | new |
| Solana | `4NyK1AdJBNbgaJ9EsKz3J4rfeHsuYdjkTPg3JaNdLeFw` | Coinbase | Hot (public name "Coinbase Hot Wallet 4 (4NyK1)", tag "Coinbase Exchange: Hot Wallet", tags #Coinbase Exchange and #Exchange Wallet) | `explorer_tag` | [link](https://solscan.io/account/4NyK1AdJBNbgaJ9EsKz3J4rfeHsuYdjkTPg3JaNdLeFw) | 2026-11-04 | high | $11,768.65 | $11,768.65 | new |
| Solana | `D89hHJT5Aqyx1trP6EnGY9jJUB3whgnq3aUvvCqedvzf` | Coinbase | Hot (public name "Coinbase Hot Wallet 3", tag "Coinbase Exchange: Hot Wallet", tags #Coinbase Exchange and #Exchange Wallet) | `explorer_tag` | [link](https://solscan.io/account/D89hHJT5Aqyx1trP6EnGY9jJUB3whgnq3aUvvCqedvzf) | 2026-11-04 | high | $10,783.90 | $10,783.90 | new |

**Kraken: none found, and the amount is unknown, not zero.** Kraken confirms Tempo, but we found no source tying a name to any Tempo wallet: Tempo's explorer page showed no name and didn't load its data in our automated read. We also found no Kraken address list for OUSD. Its order book suggests it holds or can reach OUSD, but not where.

**Found but not counted as exchanges:**

- Ethereum `0xcfc0f98f30742b6d880f90155d4ebb885e55ab33`, Etherscan tag "Zero Hash 1", $25,013.00. It is named, but we read Zero Hash as infrastructure for other firms rather than a trading venue, so `exchange` could overstate what the source says.
- A Tempo wallet with a very small balance carries a name on a public address list, but that list covers EVM chains generally and no source ties the name to Tempo.

### Label rows added

These use the exact `labels.csv` columns, and `solscan.io` is now an `explorer_tag` host in `labels/README.md`.

```csv
chain,address,entity,category,source_type,source_url,confidence,date_checked
solana,9obNtb5GyUegcs3a1CbBkLuc5hEWynWfJC6gjz5uWQkE,Coinbase,exchange,explorer_tag,https://solscan.io/account/9obNtb5GyUegcs3a1CbBkLuc5hEWynWfJC6gjz5uWQkE,high,2026-11-04
solana,FpwQQhQQoEaVu3WU2qZMfF1hx48YyfwsLoRgXG83E99Q,Coinbase,exchange,explorer_tag,https://solscan.io/account/FpwQQhQQoEaVu3WU2qZMfF1hx48YyfwsLoRgXG83E99Q,high,2026-11-04
solana,4NyK1AdJBNbgaJ9EsKz3J4rfeHsuYdjkTPg3JaNdLeFw,Coinbase,exchange,explorer_tag,https://solscan.io/account/4NyK1AdJBNbgaJ9EsKz3J4rfeHsuYdjkTPg3JaNdLeFw,high,2026-11-04
solana,D89hHJT5Aqyx1trP6EnGY9jJUB3whgnq3aUvvCqedvzf,Coinbase,exchange,explorer_tag,https://solscan.io/account/D89hHJT5Aqyx1trP6EnGY9jJUB3whgnq3aUvvCqedvzf,high,2026-11-04
```

The three existing Coinbase rows stay as they are, and their tags were re-read today.

## 3. Candidates: two lists

### Public source names it

Only the seven wallets above. **None of the six candidates in the brief is named by any source we could read.**

### Behaves like one, not nameable

The two candidates with large flows into Bridge aren't exchange-like. On Ethereum, `0xb0d0…5da2` took 59,922,793.12 and sent it all on. On Tempo, `0x8458…05cb` took 155,759,361.59, through the backup. Every outflow from both goes to the Bridge wallet, and both stay unnamed `issuer_route` rows.

Other wallets we looked at, and why they aren't on the list:

- One wallet holds a large balance on several chains, directly from Bridge, with no named exchange in its flows.
- Distributor wallets are funded by Bridge and pay many receivers. Their pages show no name, and they don't fit the rule.
- One Base wallet took a small inflow from outside the set, so it fails the rule, and it isn't yet old enough to count as placed.

The list below is built by a written rule so that it can be challenged. It is a sensitivity, and a wallet on it is not named by being listed.

- **Tier 1:** on Ethereum, Base or Solana, held at least $1M on 2026-11-03, has no label, took an inflow of at least $1M from a wallet a public source names as an exchange, every inflow of $1 or more was from those named wallets, and it sent at most 2% of its inflows anywhere else. Two wallets rely on that allowance.
- **Tier 2:** the same rule on Tempo, using a hub no source names. It is here only because it takes the same place in the fan-out as the named hubs.
- **Tier 3, weak:** wider Tempo links, through unnamed wallets. No source ties any of them to an exchange.

| Tier | Chain | Wallets | Placed on 2026-11-03 |
|---|---|---|---|
| 1 | Ethereum | 13 | $79.70M |
| 1 | Base | 11 | $47.94M |
| 1 | Solana | 11 | $49.87M |
| 2 | Tempo | 12 | about $25M |
| 3 | Tempo | 5 | about $85M |

**Label sites and tags.** Automated reads of Arkham and DeBank returned nothing, so the maintainer opened them by hand; the results are under "Decision and later checks". The four Etherscan pages for tier 1 wallets that first stayed blocked were all read later, and none has a name tag.

## 4. Impact on placed and the headline

The rebuild from the read-only backup matches the published journey for 2026-11-03 on all four chains, to the base unit, for total, issuer inventory, placed, each venue type, free-floating, placed wallets and holders.

**Finding: admissible addresses only.** No placed supply moves. $39,987.00 moves from free-floating to exchange venues on Solana, so exchange venues go from $306,592.21 to $346,579.21: Ethereum $260,956.24, Base $45,635.97, Solana $39,987.00, and Tempo unknown. Placed stays 77.07%, and the verdict stays "Mostly placed".

**Sensitivity, not a finding.**

| Moves out of placed | Tempo | Ethereum | Base | Solana | All chains | Share of total supply |
|---|---|---|---|---|---|---|
| Admissible | 0.00M | 0.00M | 0.00M | 0.00M | 0.00M | 0.00% |
| Tier 1 | 0.00M | 79.70M | 47.94M | 49.87M | 177.51M | 19.98% |
| Tier 2 | about 25M | 0.00M | 0.00M | 0.00M | about 25M | about 3% |
| Tier 3 | about 85M | 0.00M | 0.00M | 0.00M | about 85M | about 9% |

| Scenario, placed after the move (share of chain) | Tempo | Ethereum | Base | Solana | All chains |
|---|---|---|---|---|---|
| Published and admissible: nothing moves | 466.16M (76.98%) | 99.31M (88.53%) | 66.44M (73.02%) | 52.81M (66.27%) | 684.70M (77.07%) |
| Sensitivity, tier 1 | 466.16M (76.98%) | 19.60M (17.47%) | 18.50M (20.33%) | 2.94M (3.68%) | 507.19M (57.09%) |
| Sensitivity, tiers 1 and 2 | about 440M (about 73%) | 19.60M (17.47%) | 18.50M (20.33%) | 2.94M (3.68%) | about 480M (about 54%) |
| Sensitivity, tiers 1, 2 and 3 | about 355M (about 59%) | 19.60M (17.47%) | 18.50M (20.33%) | 2.94M (3.68%) | about 400M (about 45%) |

Reading the sensitivity:

- **Overall:** placed stays over 50% unless more than 240.54M moves. Tiers 1 and 2 reach about 480M placed, or about 54%. Only the weak tier 3 takes it to about 45%, where the verdict would read "Mixed", since everyday volume is 3.61% of supply, under the 5% needed for "Moving".
- **By chain:** the question matters much more outside Tempo. Tier 1 alone takes Ethereum, Base and Solana well under 50%. Tempo stays high.
- **The sentence and the number can part ways.** Moving a wallet to a venue label lowers "placed", but its balance is no less still. So "sitting still" stays true of those dollars under any label. What changes is whether stillness says anything about use.
- **Velocity would shift a lot, and that's easy to miss.** Moving placed into a venue raises circulating supply, the denominator. Across chains, circulating goes from 164.16M to 341.68M if tier 1 moved.

| Chain | Clean volume, 7 days | Circulating today | Velocity today | Circulating if tier 1 moved | Velocity if tier 1 moved |
|---|---|---|---|---|---|
| Tempo | 53.51M | 129.96M | 5.88% a day | 129.96M | 5.88% a day |
| Ethereum | 17.52M | 2.84M | 88.22% a day | 82.54M | 3.03% a day |
| Base | 6.54M | 14.50M | 6.44% a day | 62.43M | 1.49% a day |
| Solana | 41.01M | 16.87M | 34.73% a day | 66.74M | 8.77% a day |

Everyday volume barely changes: the tier 1 and 2 wallets had under $0.1M in transfers in the 7 days, under 0.01% of supply.

## 5. Is it idle?

Turnover here is (in + out) / 2, divided by average daily balance over the window. Windows end on 2026-11-03: 7 days from October 28, 14 from October 21, 30 from October 5. Amounts are in OUSD, rounded for groups that aren't published wallet by wallet. The history comes from the backup, which is complete through 2026-11-03.

| Group | Window | Wallets | In | Out | Transfers | Average balance | Turnover | Wallets with no transfer |
|---|---|---|---|---|---|---|---|---|
| Admissible named wallets | 7 days | 7 | 50,158.98 | 84,084.74 | 13 | 353,860.39 | 18.97% | 2 |
| Admissible named wallets | 14 days | 7 | 1,089,426.21 | 1,123,310.90 | 19 | 367,168.01 | 301.32% | 1 |
| Admissible named wallets | 30 days | 7 | 157,089,466.21 | 182,084,956.92 | 75 | 376,002.25 | 45,102.71% | 1 |
| Sensitivity tiers 1 and 2 | 7 days | 47 | 0 | under 0.1M | 2 | about 200M | 0.01% | 45 |
| Sensitivity tiers 1 and 2 | 14 days | 47 | 0 | under 0.1M | 3 | about 200M | 0.02% | 45 |
| Sensitivity tiers 1 and 2 | 30 days | 47 | about 100M | about 45M | 37 | about 200M | about 37% | 33 |
| Sensitivity tier 3 | 7 days | 5 | under 0.1M | 0 | 2 | about 85M | 0.03% | 4 |
| Sensitivity tier 3 | 14 days | 5 | under 0.1M | 0 | 2 | about 85M | 0.03% | 4 |
| Sensitivity tier 3 | 30 days | 5 | about 15M | about 45M | 13 | about 85M | about 34% | 3 |
| Other placed wallets | 7 days | 18 | about 80M | about 60M | 3063 | about 420M | 16.50% | 9 |
| Other placed wallets | 14 days | 18 | about 80M | about 65M | 5066 | about 410M | 17.61% | 9 |
| Other placed wallets | 30 days | 18 | about 295M | about 95M | 10074 | about 380M | about 51% | 2 |

Per named wallet:

| Wallet | Window | In | Out | Transfers | Average balance | In from outside the listed wallets | Out to outside the listed wallets |
|---|---|---|---|---|---|---|---|
| Base `0x20fe…3b7a` | 7 days | 25,036.97 | 25,010.00 | 2 | 45,632.12 | 25,036.97 | 25,010.00 |
| Ethereum `0xa9d1…3e43` | 7 days | 0.00 | 9,048.74 | 5 | 219,674.41 | 0.00 | 9,048.74 |
| Ethereum `0xcd53…ca7b` | 7 days | 25,122.01 | 25,013.00 | 4 | 44,994.00 | 10.00 | 25,013.00 |
| Solana `4NyK1A…LeFw` | 7 days | 0.00 | 3.00 | 1 | 11,768.65 | 0.00 | 3.00 |
| Solana `9obNtb…WQkE` | 7 days | 0.00 | 0.00 | 0 | 3,249.05 | 0.00 | 0.00 |
| Solana `D89hHJ…dvzf` | 7 days | 0.00 | 0.00 | 0 | 10,783.90 | 0.00 | 0.00 |
| Solana `FpwQQh…E99Q` | 7 days | 0.00 | 25,010.00 | 1 | 17,758.26 | 0.00 | 25,010.00 |
| Base `0x20fe…3b7a` | 14 days | 1,025,098.80 | 1,025,010.00 | 4 | 45,598.48 | 1,025,098.80 | 1,025,010.00 |
| Ethereum `0xa9d1…3e43` | 14 days | 0.00 | 9,048.74 | 5 | 222,334.70 | 0.00 | 9,048.74 |
| Ethereum `0xcd53…ca7b` | 14 days | 25,132.01 | 25,023.00 | 6 | 44,947.49 | 20.00 | 25,023.00 |
| Solana `4NyK1A…LeFw` | 14 days | 0.00 | 3.00 | 1 | 11,770.15 | 0.00 | 3.00 |
| Solana `9obNtb…WQkE` | 14 days | 0.00 | 0.00 | 0 | 3,249.05 | 0.00 | 0.00 |
| Solana `D89hHJ…dvzf` | 14 days | 0.00 | 39,216.15 | 1 | 24,789.67 | 0.00 | 39,216.15 |
| Solana `FpwQQh…E99Q` | 14 days | 39,195.40 | 25,010.00 | 2 | 14,478.47 | 0.00 | 25,010.00 |
| Base `0x20fe…3b7a` | 30 days | 1,025,098.80 | 1,031,510.00 | 5 | 47,304.45 | 1,025,098.80 | 1,031,510.00 |
| Ethereum `0xa9d1…3e43` | 30 days | 127,999,995.00 | 128,009,048.76 | 48 | 223,754.32 | 81,999,995.00 | 28,009,053.76 |
| Ethereum `0xcd53…ca7b` | 30 days | 28,025,177.01 | 52,980,169.01 | 18 | 44,931.66 | 28,000,065.00 | 50,025,162.01 |
| Solana `4NyK1A…LeFw` | 30 days | 0.00 | 3.00 | 1 | 11,770.95 | 0.00 | 3.00 |
| Solana `9obNtb…WQkE` | 30 days | 0.00 | 0.00 | 0 | 3,249.05 | 0.00 | 0.00 |
| Solana `D89hHJ…dvzf` | 30 days | 0.00 | 39,216.15 | 1 | 38,235.20 | 0.00 | 39,216.15 |
| Solana `FpwQQh…E99Q` | 30 days | 39,195.40 | 25,010.00 | 2 | 6,756.62 | 0.00 | 25,010.00 |

**What this shows:**

- **Custody-pattern wallets look still, and stiller than other placed wallets.** Across tiers 1 and 2, 45 of 47 wallets had no transfer at all in 7 or in 14 days. Other placed wallets turned over 16.50% and 17.61%, though half of them, holding most of the group's balance, were also quiet.
- **Their 30-day turnover isn't use.** The 36.65% for tiers 1 and 2 is almost all one day, October 5, when about $100M came in and about $45M went out, nearly all of it with the named hubs. That day is the first in the window. Since then the total is under $0.1M out, and nothing in.
- **Named hot wallets do move money, but very little, against tiny balances.** That is why their turnover looks extreme: 18.97% in 7 days on about $135K of flows, and 45,103% over 30 days, nearly all of it on October 5: $156.00M of the $157.09M in, and $180.95M of the $182.08M out. Gross flow in the last 7 days was $134,243.72. In the last 14 days it was $2.21M.
- **Visible exchange trading looks thin.** Kraken's ticker showed 14.02 OUSD traded in 24 hours, and Coinbase Exchange has no public OUSD book. This is one reading on one day.

**What the chain can't show:**

- Anything inside an exchange's own ledger: trading between its clients, client balances, rewards, lending or treasury use. A wallet that never moves can back heavy internal activity, or none at all.
- Who owns a custody wallet. It could be the exchange, or a client of its custody business. Those mean different things for "in use".
- Rewards earned by holding. Open Standard says partners "earn rewards proportional to the supply and activity they drive", and CoinDesk quotes its CEO saying founders may hold OUSD on their balance sheets. So a balance can earn its holder money without moving. That is a reason to hold, and doesn't show demand from anyone else.

**Result: neither view is established.** The chain gives no sign of use for these balances, and it can't see where use would happen. So "idle" overclaims, and "in use" has no evidence behind it. The accurate wording is that the balances haven't moved on the chain, and that use inside an exchange, if any, can't be seen.

## 6. Presentation

| | Option A: floor note only | **Option B: named floor plus an unnamed band (pick)** | Option C: move custody out of placed |
|---|---|---|---|
| What changes | Exchange rows per named exchange, with a "labeled floor" marker and a sentence giving the sensitivity range | Option A, plus a band inside placed, "exchange-linked", found by the tier 1 rule and named after no one | Tier 1 is counted as exchange venue. The headline number falls to 57.09% |
| Placed share | 77.07% | 77.07%, with 177.51M of it marked | 57.09% |
| Circulating, velocity | Same | Same | Rises to 341.68M, and Ethereum velocity falls from 88.22% to about 3% a day |
| Integrity | Clean, but says little | Clean: an unnamed cluster, the same pattern as `issuer_route`, with its rule published | **Breaks a rule.** It treats inference as a source, since no source names these wallets as an exchange's |
| Cost to change later | Very low | Low: one category and one band, and removing them restores today's numbers | High: the headline moves, then moves back if a wallet proves to be a client's |

**Pick: option B.** It answers the maintainer's concern on the page without saying anything no source says. It can be undone without a change to any published headline.

How it would look on the supply journey and verdict:

- **Per-exchange rows under Venue:** "Coinbase, $346,579.21, 7 wallets" and "Kraken, no wallet labeled". A zero would mislead, so Kraken's row gives no amount.
- **A floor marker on the exchange total:** "at least", with the note "Counts only wallets a public source names. Custody with no published label isn't here."
- **The band:** "of which exchange-linked, 177.51M. These wallets took their OUSD from wallets a public source names as an exchange. No source says who holds them."
- **A coverage line, per chain:** which chains have any named exchange wallet. Today that is Ethereum, Base and Solana, not Tempo.

The wording as built is in `docs/PRD.md` section 7 and `docs/methodology.md`.

### Decisions

- Solscan name as a source -> counts as `explorer_tag` (alternative: leave out Solana; cost to change later: drop four rows, $39,987.00).
- Solscan confidence -> high. The build coordinator read all four pages in a browser on 2026-11-04, and each shows the tag "Coinbase Exchange: Hot Wallet" (alternative: all medium; low cost).
- Zero Hash -> named but not counted as an exchange (alternative: count it; adds $25,013.00, low cost).
- A name from an EVM address list on a Tempo wallet -> not counted, since no source ties it to Tempo (alternative: count it; adds almost nothing).
- Public address compilation -> a lead for finding wallets, not a naming source for new rows (alternative: use it as a source; needs a host decision).
- Tempo hub -> sensitivity tier 2 only, since no source names it (alternative: tier 1; moves about 25M).
- Outflow allowance -> 2% of inflows, which keeps two wallets in tier 1 (alternative: no allowance; tier 1 falls by about a quarter).
- A public Dune query snippet that surfaced in a search -> quoted from the result and not opened, given the no-Dune rule (alternative: open it; would add only an author's inference).
- Base balance retries -> after timeouts, the retry could also fall back to a public Base endpoint, which the brief didn't name, and the script didn't record which one answered. All four values match the backup's balances.

### Outside this brief, for the maintainer

Solana `J95uU8JeFEGi9A5y3mHRNTM5nNkYSVM2RZ7twqJuYMyw` and `AwTxkKrszDzH8WPxqUHS1sTJna5Fagw5xio8kTXWjnfn` appear to fit the collection-wallet rule in `labels/README.md`: many senders, every outgoing transfer to hub `Hmc2…D4ni`, and almost no balance. Neither is in `labels.csv`. `J95u` took $17.94M in the last 7 days, against Solana's published clean volume of $41.01M, so a missing label may be overstating Solana's clean volume. Not checked further, and not changed.

## Appendix: reads behind each figure

**Data.** The history comes from `data/ousd.pre-reconciliation.duckdb`, opened read-only, written 2026-11-04 09:07 UTC. It ends at Tempo block 47324696, Ethereum block 26338376, Base block 53490000 and Solana slot 465219960, so it stops on November 4 and is complete through 2026-11-03. Neither `data/ousd.duckdb` nor `data/marts.duckdb` was opened. Published figures come from `data/published/20261104T163224Z`, read as files. All chain and token matching uses the four contract addresses in `docs/methodology.md`.

**Rebuild check, per wallet for 2026-11-03.** The logic of `int_wallet_events`, `int_wallet_days`, `int_wallet_placed` and `mart_supply_journey`, run in memory over the backup and the current `labels/labels.csv`:

```sql
-- still_value, per wallet and day: n = 14
case when count(*) over w_full = 15
     then least(first_value(close_balance) over w_full, min(day_min) over w_after) end
-- w_full: 14 preceding to current. w_after: 13 preceding to current.
-- placed_part: still_value when category is null and still_value >= 1000000000000, else 0.
select chain, sum(bal), sum(bal) filter (where category in ('issuer','issuer_route')), sum(placed_part),
       sum(bal) filter (where category = 'dex'), sum(bal) filter (where category = 'lending'),
       sum(bal) filter (where category = 'exchange'),
       sum(bal - placed_part) filter (where category is null or category = 'system'),
       count(*) filter (where placed_part > 0), count(*)
from wallet_day where day_utc = date '2026-11-03' and bal > 0 group by 1;
-- Compared with journey.csv for 2026-11-03: every field equal, on all four chains.
```

**Tiers, for the wallets above:**

```sql
-- cand: bal >= 1000000000000 on 2026-11-03, category is null.
-- For each cand, over all transfers of value >= 1 OUSD:
--   total_in and in_hub (from the hub set), max_hub (largest single inflow from a hub),
--   total_out and out_hub (to the hub set).
-- Keep where in_hub > 0, then in the tier where total_in - in_hub < 1, max_hub >= 1000000,
-- and total_out - out_hub <= 2% of total_in.
-- Hub set: Ethereum 0xa9d1…, 0xcd53…. Base 0x20fe…. Solana 9obN…, 4NyK…, Fpwq…, D89h…. Tier 2: one unnamed Tempo wallet.
```

**Impact.** For each set: `sum(placed_part)` per chain, subtracted from published `placed_supply`. Shares are `placed * 10000 // total`, as in `pipeline/ousd/verdict.py`. Velocity is `clean_7d * 10000 // (7 * circulating)`, using `summary.json`, with circulating as total minus issuer inventory minus placed, plus the set's `placed_part`.

**Flows and turnover:**

```sql
-- In and out per wallet, for each window, from transfers:
select chain, address, sum(in_value), sum(out_value), count(*) from legs
where day_utc between date '2026-11-03' - interval (n - 1) day and date '2026-11-03' group by 1, 2;
-- Average balance: avg(close_balance) from the daily wallet table, over the same days.
-- Group turnover: (sum(in) + sum(out)) / 2 / sum(avg_balance).
-- "Outside the listed wallets": counterparty not in the named or tier sets.
```

**Candidate flows.** `sum(value)` from transfers with `to_address = x` and with `from_address = x`, grouped by counterparty, all history in the backup. So the 155,759,361.59 figure for `0x8458` is through the backup, and may read a little lower than a later figure.

**Current balances, at 2026-11-04T19:40:34Z, 71 reads:**

- EVM: `eth_call` of `balanceOf(address)` on the OUSD contract, at Tempo block 47439421, Ethereum block 26343642 and Base block 53516042. The Tempo and Ethereum reads used the public defaults in `pipeline/ousd/chains.py`, and Base used `BASE_RPC_URL`. See the Decisions list for the retry.
- Solana: one `getAccountInfo` on the mint, which showed the Token-2022 program, then `getTokenAccountBalance` on each wallet's derived associated token account, at the finalized commitment. Used 16 calls of the 30 allowed.

**Exchange checks.** Public, unauthenticated GET requests, no accounts, run on 2026-11-04.

- Coinbase: `api.exchange.coinbase.com/currencies/OUSD`, `/products`, `/products/OUSD-USD`, `/products/OUSD-USDC`, `api.coinbase.com/api/v3/brokerage/market/products?product_ids=OUSD-USD`.
- Kraken: `api.kraken.com/0/public/Assets?asset=OUSD`, `AssetPairs`, `Ticker?pair=OUSDUSD`, `Depth?pair=OUSDUSD&count=3`.
- Returned no Open USD: `api.binance.com/api/v3/exchangeInfo?symbol=OUSDUSDT`, `api.binance.us/api/v3/exchangeInfo?symbol=OUSDUSD`, `www.okx.com/api/v5/public/instruments?instType=SPOT&instId=OUSD-USDT` and `OUSD-USD`, `www.okx.com/api/v5/market/tickers?instType=SPOT`, `api.bybit.com/v5/market/instruments-info?category=spot&symbol=OUSDUSDT`, `api.mexc.com/api/v3/exchangeInfo?symbol=OUSDUSDT`, `api.bitget.com/api/v2/spot/public/coins?coin=OUSD`, `api.huobi.pro/v2/reference/currencies?currency=ousd`, `api.gemini.com/v1/symbols/details/ousdusd`, `www.bitstamp.net/api/v2/currencies/`, `api.exchange.bullish.com/trading-api/v1/markets`, `api.crypto.com/exchange/v1/public/get-instruments`, `api.upbit.com/v1/market/all`, `api.bithumb.com/v1/market/all`, `api-pub.bitfinex.com/v2/conf/pub:list:currency`, `api.lbkex.com/v2/accuracy.do`, `api.bitso.com/v3/available_books/`, `api.bitvavo.com/v2/assets?symbol=OUSD`, `whitebit.com/api/v4/public/assets`, `api.backpack.exchange/api/v1/assets`, `api.woox.io/v3/public/instruments`, `api.poloniex.com/currencies/OUSD`, `api.coinone.co.kr/public/v2/currencies/OUSD`, `api.korbit.co.kr/v2/currencies`, `api.bitflyer.com/v1/markets`, `open-api.bingx.com/openApi/spot/v1/common/symbols?symbol=OUSD-USDT`, `sapi.xt.com/v4/public/symbol?symbol=ousd_usdt`, `api.phemex.com/public/products`, `openapi.bitrue.com/api/v1/exchangeInfo`. In the larger lists, matches such as `ALGOUSD` and `OPEN` are other assets.
- Other tokens under the ticker: `api.kucoin.com/api/v3/currencies/OUSD`, `api.gateio.ws/api/v4/spot/currencies/OUSD`.
- Failed or refused: `api.coinex.com/v2/spot/market?market=OUSDUSDT` (503), `api-cloud.bitmart.com/spot/v1/currencies` (no response), `ascendex.com/api/pro/v2/assets` (403), `api.robinhood.com/midlands/currency_pairs/` (404), `www.etoro.com/markets/ousd` (page with no usable data).
- Aggregators: `api.coingecko.com/api/v3/coins/open-usd/tickers`, with `exchange_ids=gdax` and `exchange_ids=binance`, and `api.coinmarketcap.com/data-api/v3/cryptocurrency/market-pairs/latest?slug=open-usd&category=spot`.

**Address lists.** All OUSD addresses that ever sent or received in the backup were matched against the public files `cex_evms_addresses.sql` and `cex_solana_addresses.sql` in the `duneanalytics/spellbook` GitHub repository, and a public Etherscan label snapshot in `brianleect/etherscan-labels`. These were read as files from GitHub with no Dune tool or account. On EVM chains the matches were Coinbase's three labeled wallets, Zero Hash 1 and one other firm's wallet. On Solana there were none, so that list doesn't include the wallets Solscan names.

**Tags.** Read from explorer pages on 2026-11-04: Etherscan and Basescan address pages, Basescan's OUSD holder list, Solscan account pages, Blockscout's address API for five candidates on Ethereum and Base (no tags), and Tempo's explorer (no name shown, and its data didn't load). Etherscan's OUSD holder list refused the read.

**Other sources:** [Open Standard launch post](https://joinopenstandard.com/blog/ousd-is-live/), [Open Standard site](https://joinopenstandard.com/), [Crystal first-week analysis](https://crystalintelligence.com/stablecoin/ousd-stablecoin-first-week-on-chain-analysis/), [CoinDesk launch report](https://www.coindesk.com/business/2026/09/24/open-usd-takes-on-tether-circle-with-a-different-stablecoin-model-that-s-building-money), [Tempo launch post](https://www.linkedin.com/posts/tempo_open-usd-ousd-is-live-on-tempo-with-400m-activity-7511080102575763457-OLQ7).
