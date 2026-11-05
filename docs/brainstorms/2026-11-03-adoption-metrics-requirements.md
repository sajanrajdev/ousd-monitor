# Adoption metrics: requirements from real data

**Status:** settled for Phase 2. Numbers will move once Base and Solana arrive.
**Date:** 2026-11-03
**Unit:** 2.1 in `docs/implementation-plan.md`. Feeds `docs/plans/2026-11-03-001-insight-models-plan.md` and PRD section 7.

## Question

Which definitions answer "is supply turning into money that moves?", and do they hold up on real data?

## Data used

| Chain | Coverage | Transfers | Reconciled? |
|---|---|---|---|
| Tempo | Full, close of 2026-11-03 UTC | 367,108 | Yes. Mints minus burns equal `totalSupply()` at block 47312916, exactly |
| Ethereum | Partial, close of 2026-10-21 UTC | 27,919 | Not yet, because the sync is still running. Treat as unreconciled |
| Base | None | 0 | No |
| Solana | None | 0 | No |

Taken from a copy of the database at about 01:54 UTC on 2026-11-04. Figures are OUSD, shown to two decimals or rounded.

**Share of supply measured.** A live read at about 02:00 UTC on 2026-11-04 gave Tempo 617.12M, Ethereum 112.17M, Base 90.98M and Solana 79.67M, summing to 899.94M. Bridge reported 899.94M, a difference of $1,134. Base and Solana are 19% of supply. Ethereum fell by about 17M after our data ends, and we can't yet see where that went.

**Our data matches Crystal's published numbers.** That gives some confidence in both the data and the reading of the article.

| Crystal, October 5 | Our data |
|---|---|
| Tempo supply $472.8M, minted $523.6M, burned $50.9M | 472.8M, 523.65M, 50.85M |
| Ethereum minted $60.5M, burned under $0.1M | 60.46M, 0.02M |
| 8,377 Tempo fee payments worth $3.33 | The 8,377th fee row brings the total to exactly $3.33 |
| $1.19B Tempo non-fee volume, 60% touching Bridge's wallet | $1.186B once mints and burns are excluded, 59.9% |
| Eight Tempo wallets staged $396M | Eight wallets of $10M to $200M total $395.0M |
| One wallet received and returned $95M | `0x9272…528d` received 95.0M and sent it all back |
| 11,544 Tempo transfers | 11,899 at the same fee count, **3% apart and not explained** |

## What the data says

### 1. Most supply sits still

| | Tempo, Nov 3 | Share | Ethereum, Oct 21 | Share |
|---|---|---|---|---|
| Total | 605.52M | | 129.50M | |
| Issuer inventory | 9.40M | 1.6% | 10.07M | 7.8% |
| Placed | 466.16M | 77.0% | 89.73M | 69.3% |
| Venues | 52.57M | 8.7% | 0.27M | 0.2% |
| Free-floating | 77.39M | 12.8% | 29.43M | 22.7% |
| **Circulating** (venues plus free-floating) | 129.96M | 21.5% | 29.70M | 22.9% |

- Tempo has 1,400 holders, but 42 of them hold $1M or more and own 97% of its supply. The top 10 hold 75%. Ethereum's top 10 hold 89%.
- Crystal's eight staged wallets held $395.0M on October 5. Today $200M has not moved at all, $10M also hasn't, and $100.0M moved once to a fresh wallet that hasn't moved since. The eighth wallet still holds 43.85M after sending 25M and 16M onward.
- The largest "use" of OUSD on Tempo is a parked balance: **Sentora OUSD Main holds 44.38M, 7.3% of Tempo's supply**. Press reports say nearly all of it is idle, and on-chain its OUSD balance is about equal to its reported `totalAssets`.

### 2. Headline volume is mostly not use

Tempo, Day 0 to November 3, and Ethereum, Day 0 to its data end. Each row excludes what the rows above took out, and the parts add back to the headline exactly, to the base unit.

| Part | Tempo | Share | Ethereum | Share |
|---|---|---|---|---|
| **Headline** | 2,319.40M | 100% | 730.98M | 100% |
| Mints | 282.15M | 12.2% | 122.06M | 16.7% |
| Burns | 101.09M | 4.4% | 2.46M | 0.3% |
| Fees | $21.05 | 0% | n/a | |
| Issuer flows | 985.79M | 42.5% | 138.00M | 18.9% |
| Same-transaction netting | 396.44M | 17.1% | 2.32M | 0.3% |
| DEX flow | 14.34M | 0.6% | 1.52M | 0.2% |
| Lending flow | 50.23M | 2.2% | 0 | |
| Clean, transfers of $1M or more | 473.13M | 20.4% | 461.73M | 63.2% |
| **Clean, under $1M ("everyday")** | **16.23M** | **0.7%** | **2.89M** | **0.4%** |

Three things stood out that the PRD did not anticipate:

- **One balance looping.** `0x67d5…12a6` and `0xa43d…a0d5` passed one balance of about $12,478 back and forth, eight times per transaction, in 3,247 transactions from October 20 to 28. That alone is 323.9M, or 14% of Tempo's headline since Day 0. It nets to zero inside each transaction. It has stopped. We make no claim about why.
- **Multi-hop deposits.** One deposit into the Sentora vault appears as four to six transfers in one transaction, so a single dollar counts several times.
- **Large transfers dominate clean volume.** 81 Tempo transactions make up 97% of clean volume. The ones inspected look like holders moving balances between their own wallets: for example, four wallets each emptied to a fresh wallet that then sat still. There's no public evidence these are the same entity, so we can't remove them. We split them out instead.

### 3. Everyday activity is small, and rising from a low base

Tempo, by calendar week starting Monday:

| Week of | Headline | Clean, $1M+ | Clean, everyday | Clean transactions |
|---|---|---|---|---|
| Sep 28 (launch) | 1,750.28M | 267.13M | 6.38M | 168 |
| Oct 5 | 224.92M | 69.73M | 1.22M | 176 |
| Oct 12 | 197.27M | 72.77M | 1.44M | 152 |
| Oct 19 | 303.03M | 12.78M | 1.35M | 283 |
| Oct 26 | 638.54M | 0 | 3.13M | 2,157 |
| Nov 2 (2 days) | 169.74M | 50.72M | 2.73M | 199 |

Over the last 7 days, everyday volume was 4.63M, or **0.76% of Tempo's supply**. That's three to four weeks of history, so call it a direction, not a trend.

**Velocity, Tempo, last 7 days (daily average):**

| Measure | Value |
|---|---|
| Headline volume over total supply (the common definition) | 17.44% a day |
| Clean volume over circulating supply (ours) | 6.08% a day |
| Everyday volume over circulating supply | 0.50% a day |

**Active wallets, Tempo:** 136 wallets sent at least $1 of clean volume in the last 7 days. 59 sent at least $100. Over 30 days those are 425 and 107. Ethereum, last 7 days of its data: 30 and 20.

### 4. Issuance has a small-ticket side

Bridge's hub wallet sent 2,441 transfers under $100K to 237 recipients in the week of October 26, totaling 4.07M. In the week of October 5, it sent 93 to 32 recipients, totaling 0.03M. Issuer flows are excluded from clean volume by definition, so this signal would disappear. It looks like the on-ramp being used, but we can't prove that. It should be shown as its own line next to the waterfall.

### 5. Where the growth went

Tempo supply rose 132.7M from October 5 to November 3. The largest net gains: Sentora vault 44.4M, `0xe5c7…1e5a` 39.7M, `0xcc9b…7867` 18.5M, `0x094c…cc25` 14.1M, `0xe413…e0dd` 10.0M. So the growth went mostly into a few large balances and one vault.

## Settled definitions

Each threshold is a dbt variable, so changing one is a single-line reversible edit. PRD section 7 carries the final wording.

### Placed supply: N = 14 days, threshold $1M

**Definition:** for a wallet with no venue, issuer or system label, the lowest its balance has been across the last 14 days, counted only if that amount is at least $1M and the wallet is at least 14 days old.

The PRD's "no outbound transfer for N days" fails in three ways on real data:

- Any small outbound resets the clock on the whole balance. Paying a Tempo fee in OUSD counts as an outbound.
- A wallet that received $4M yesterday has "no outbound" and counts as placed.
- A wallet that sent half its balance last week counts as not placed at all.

Trailing minimum balance fixes all three: only dollars that actually stayed count.

| N (days) | Tempo: $100K | **$1M** | $10M | Ethereum: $1M |
|---|---|---|---|---|
| 7 | 467.2M | 466.2M | 426.7M | 113.6M |
| **14** | 466.7M | **466.2M** | 426.7M | 89.7M |
| 21 | 398.4M | 396.8M | 361.5M | 0 |
| 30 | 309.7M | 309.2M | 273.9M | 0 |

The PRD's literal rule gives 446.7M at N = 14, and a dust-tolerant version gives 438.6M.

- **Why 14:** Tempo is flat from 7 to 14 and then falls, because wallets that repositioned in mid-October drop out at 21. 14 skips a week of behavior without demanding more history than a 5-week-old coin has. Ethereum's zero at 21 and above comes from its data ending October 21, three weeks after funding, not from movement.
- **Why $1M:** the choice barely matters between $100K and $1M, a 0.5M difference. It keeps Crystal's framing and the PRD's.
- **Weakness:** 14 lags. Supply placed after October 20 isn't counted yet, and the first valid reading for any wallet is 14 days after funding, so the series reads low through mid-October (273.6M on October 14). The site must not chart it before October 14.
- **Limit:** this measures behavior, not intent. A placed balance may be a customer's or a partner's.

The verdict holds across this range: at the harshest setting tested, N = 30, 51% of Tempo is placed.

### Issuer inventory

Balances of wallets labeled `issuer` or `issuer_route`. 9.40M on Tempo, 10.07M on Ethereum. Only one hub wallet is named. The rest are an unnamed redemption route, with almost no balance, so naming matters little here.

Wallets with large flows to the redemption route, such as `0xe5c7…1e5a` (39.7M), stay unlabeled and count as non-issuer. If public evidence later ties them to Bridge, inventory rises.

### Venue supply

Balances of wallets labeled `dex`, `lending` or `exchange`. 52.57M on Tempo: Sentora 44.38M, Tempo's Stablecoin DEX 5.97M, Uniswap v4 2.02M, Tempo Earn 0.20M. On Ethereum, 0.27M.

**Exchange custody is not a venue unless labeled.** Crystal describes exchange custody, but it doesn't publish the addresses, so any such wallets stay unlabeled and count as placed.

### Circulating supply

As in the PRD: total minus issuer inventory and placed. It includes venues, so the journey also shows venue supply and free-floating separately. On Tempo, 40% of circulating supply is in venues, mostly the vault.

### Headline and clean volume

Clean volume starts from headline and removes, in this order: mints, burns, fees, fee liquidity, issuer flows, same-entity moves, then same-transaction netting, then venue flow. What's left is split at $1M into large and everyday.

**Same-transaction netting is new and is the key change.** Within one transaction, each address's in and out are netted, and only the amount that ended up somewhere new counts. This handles the loop and the multi-hop deposits with one rule and no labels.

**DEX flow is not DEX trading volume.** It measures net flow to and from venue contracts, including seeding. Tempo's first week shows 5.02M, about Crystal's $5M seed, while Crystal reports about $17K of trading. Real trading volume needs Swap events, which we don't ingest. So the site must call this "DEX flow".

**Same-entity moves** are 0 today, since no two labeled addresses share an entity outside the issuer. The rule stays so it starts working as labels are added.

**Multi-transaction hops are still counted.** A 10M chain on November 2 (`0xe413…e0dd`, then `0x7b26…eeae`, then `0xf5db…1bed`, then `0xabb8…ff77`, then Bridge) counts in clean volume at several hops. That's mostly caught in the $1M+ split but overstates clean volume. It's a known limit, not solved here.

### Velocity

Rolling 7-day clean volume, divided by 7, divided by circulating supply at the end of the window. Shown next to the everyday version and the common definition, because the three differ by a factor of about 35 (table above).

### Active wallets

Wallets that sent at least $1 of clean volume in the period, net per transaction, excluding wallets labeled issuer, venue or system. Labeled exchanges count.

$1 removes the 34% of wallets moving only dust: 38,417 transactions under $1 total $904 on Tempo. Many of those run through relay contracts and Tempo's ReceivePolicyGuard. A secondary count at $100 is published too. These are wallets, not people.

### Tempo fee rule

**Rule:** to the fee manager, and the last OUSD transfer in its transaction.

Tested against real receipts from Tempo's public RPC. The sample was 350 random fee rows, all 87 rows above $0.01, and all 5 rows in transactions with two transfers to the fee manager: 437 transactions and 442 rows.

| Candidate | Result |
|---|---|
| `to = fee manager` alone | Wrong for 5 of 442 rows, 115 OUSD |
| Last OUSD log in the transaction | Matches 437 of 437 true fees |
| Sender equals receipt `feePayer` | True for all 442, so it doesn't separate them |
| Amount equals `gasUsed * gasPrice / 10^12`, rounded up | Exact for all 437 true fees |

- Every sampled receipt had `feeToken` set to OUSD.
- **The 5 exceptions are not fees.** They're calls to the fee manager itself that also pay a real fee in the same transaction, totaling 115 OUSD in amounts of 5 and 50. They read as fee-liquidity deposits, though that reading comes from the call target rather than decoded calldata. They become their own class, as do 14 transfers out of the fee manager.
- **No receipts are needed.** The last-log rule works from the raw table, so the pipeline stays simple. The amount check stays available as a sampled audit.
- **Limit:** with 0 misses out of 350 random rows, the true miss rate is below about 0.9% by count at 95% confidence. Every row above $0.01 was checked, so the value at risk is well under a dollar.
- **Scale:** 160,814 rows, 43.8% of Tempo transfers, worth $23.25 in total. Two wallets paid 96% of them. Fees were sponsored in 86% of sampled transactions (the payer wasn't the sender), so fee rows say little about who is using OUSD.

### Which published sources can label wallets

Rule used: a published source must tie a name to this address. Matching a description by behavior doesn't count.

| Address | Chain | Label | Source | Confidence |
|---|---|---|---|---|
| `0x4c2c…00b8` | Ethereum, Tempo, Base | Bridge | [Etherscan tag "Bridge.xyz: Wallet 1"](https://etherscan.io/address/0x4c2c0f0bb2631b02ac9299c59690914ee7a200b8) and [Crystal](https://crystalintelligence.com/stablecoin/ousd-stablecoin-first-week-on-chain-analysis/), which names the same wallet across all three | High |
| `0xa9d1…3e43` | Ethereum | Coinbase | [Etherscan tag "Coinbase 10"](https://etherscan.io/address/0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43) | High |
| `0x0d13…df48` | Tempo | Sentora OUSD Main | [Morpho curator page](https://curator.morpho.org/vaults/4217/0x0d136e26b4d9e4836fc5cb202baeb49cb6f5df48), plus [Crypto Briefing](https://cryptobriefing.com/sentora-ousd-lending-vault-tempo/) and [The Defiant](https://thedefiant.io/news/defi/sentora-s-ousd-lending-vault-holds-42-5-million-on-tempo) | High |
| `0xb86b…3592` | Tempo | Tempo Earn | [Morpho curator page](https://curator.morpho.org/vaults/4217/0xb86b3ccce82f6cb767c45afb9fb032ae5fde3592) | Medium: the curator isn't shown |
| `0xfeec…0000`, `0xdec0…0000`, `0xb10c…0000` | Tempo | Fee Manager, Stablecoin DEX, ReceivePolicyGuard | [Tempo predeployed contracts](https://tempo.xyz/developers/docs/quickstart/predeployed-contracts) | High |
| `0x3362…7029`, `0x0000…8a90`, `0x4985…2b2b` | Tempo, Ethereum, Base | Uniswap v4 PoolManager | [Uniswap deployments](https://developers.uniswap.org/contracts/v4/deployments) | High |

**Unnamed, by behavior.** The redemption and burn route stays an unnamed `issuer_route` cluster. Crystal describes the route and says it belongs to Bridge, but publishes no addresses. The cluster is defined by the chain's own behavior: wallets on the fixed path into the burn. `0x1767…1873` is verified on Etherscan as `ReserveLedgerWrappedHandler`, created by a wallet tagged "Open Standard: Deployer", which supports the classification.

**Names a source gives that we can't use yet, because it publishes no address:**

- Crystal describes market makers and exchange custody on several chains, and publishes no addresses for them.
- Where a wallet only resembles a described pattern, such as a uniform balance repeated across many wallets, or a funding link to a tagged wallet, that is a match and not a source. The wallet's own explorer page must carry the tag or name.
- Crystal itself hedges on one large wallet, saying only that it "appears to be" in exchange custody.

None of these gets a name. Such wallets stay unnamed and unlabeled, and count as placed.

Crystal's figures are from October 5, and much has changed. For example, its staged wallets have mostly moved to new addresses, so its descriptions don't identify current holders on their own.

**No usable label source found:** Tempo's explorer page showed no tags or labels when read. ousd.fyi names no wallets. Dune was out of scope for this work.

## Candidate verdict

> On Tempo, which holds about two-thirds of OUSD, 77% of supply has sat still for at least two weeks in wallets of $1M or more, and transfers under $1M moved only $4.6M in the last week, under 1% of supply. So far this looks mostly like balance-sheet supply, with early everyday use rising from a low base.

**Does the data support it?** For Tempo, clearly: the placed share stays above half at every setting tested, and even counting large transfers, last week's clean volume is 9% of supply.

**What it doesn't support:**

- **An all-chain statement.** 19% of supply is unmeasured, and that's where Crystal saw most DEX trading. Ethereum is two weeks stale and unreconciled. The sentence must stay "on Tempo" until they arrive.
- **Why balances are parked,** or whether they're waiting for demand at all. The chain can't show intent.
- **"Rising" as a firm claim.** It rests on about four weeks, and one week's activity jump could be a single integration.
- **That everyday transfers are real commerce.** We can't tell a payment from a bot or a treasury sweep. "Everyday" means under $1M, nothing more.

The PRD question's framing, "or is it still balance-sheet supply waiting for demand", holds up. No framing change is needed, beyond scoping the sentence to the chains covered.

## What could change with Base and Solana

| Conclusion | Risk | Why |
|---|---|---|
| Placed share across all chains | **Medium** | Crystal saw exchange funds staged on both, which suggests they look similar. But they could be more active |
| Everyday volume | **High** | First-week DEX trading was almost entirely Solana (3.4M) and Base (0.7M). Everyday totals could multiply, though Base's copycat token pools need care |
| Venue supply | **High** | Pools and any lending markets there are unlabeled and unmeasured |
| Active wallets | **High** | Crystal counted 676 traders on Base's Uniswap pool in six days, far above Tempo's 136 senders a week. Trader wallets may change the picture most |
| Fee rule | None | Tempo only |
| Solana's definitions | **Medium** | Its wallets, token accounts and same-transaction shape differ from EVM. Netting and the wallet view must be checked there |
| Issuer inventory | Low | Crystal puts about $10M of it on Solana, in a wallet whose address it doesn't publish. The mint recipient rule will find it |
| Ethereum figures | Medium | The sync hasn't finished, and supply fell 17M after our data ends |

## Decisions made here

Each is reversible and recorded in the relevant doc:

1. Placed uses trailing minimum balance, N = 14, $1M.
2. Clean volume adds same-transaction netting and a $1M split, and DEX flow is named as flow.
3. Fee rule: last OUSD transfer to the fee manager.
4. Only addresses a source ties to a name get a name. Custody patterns stay unnamed.
5. Marts live in a separate database file, so raw stays read-only for modeling.
6. Publishing is blocked until all four chains reconcile, with an explicit local preview mode for Phase 3.

## Needs the maintainer

1. **Base and Solana keys.** `BASE_RPC_URL` and `SOLANA_RPC_URL` are needed for units 1.2 and 1.3. Without them, the verdict stays Tempo-only and nothing can publish.
2. **Label review before first publish.** `labels/` decides published claims, and project rules call for review. The sensitive one is naming Sentora's vault in a story about parked money. The sources support it and the framing is neutral, but it's a judgment call.
3. **The verdict wording,** before Phase 3 uses it.

## Open questions, none blocking

- The 355-row gap against Crystal's total transfer count. Their fee and value figures match exactly, so it's likely a counting choice.
- Whether the `0x1e34…f4c6` flows into the Sentora vault (21.8M, at least some arriving through Tempo's Zone contracts) are one product or many users. Worth a look before the site describes them.
