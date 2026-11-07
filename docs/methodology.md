# Methodology

This page explains every number on the site, where it comes from and how far to trust it. The site renders this file, and fills in the parts that come from the dataset: the source legend, the named labels, the unnamed clusters, the limits that change with coverage, and the settings.

## What this is and isn't

Open USD Monitor is an independent project. It is not affiliated with Open Standard or Bridge, and it uses their names only to say what it measures.

It is not financial advice, and it is not an attestation. It reads public chain data and says nothing about the reserves behind OUSD. For reserves, read Bridge's own reports: [Bridge's reporting and transparency documentation](https://apidocs.bridge.xyz/platform/issuance/reporting-and-transparency).

The question it answers is one: is OUSD supply turning into money that moves, or is it still balance-sheet supply waiting for demand? Supply is not demand, and a partner placing funds is not a customer paying.

We count 1 OUSD as $1 and don't track price.

Other sources already cover live supply, reserve coverage and pool health, and we don't compete with them. Use them for those:

- [ousd.fyi](https://ousd.fyi/): reserves against supply, and per-chain supply.
- [Bridge's transparency API](https://transparency.bridge.xyz/v0/stablecoins/ousd): issuer-reported supply.
- [DefiLlama](https://defillama.com/stablecoin/open-usd): supply and market cap history.
- [Token Terminal](https://tokenterminal.com/explorer/projects/openstandard/openusd): supply and market cap history.
- [A public Dune dashboard suite](https://dune.com/zcabrams/ousd-master): supply, holders, pools, flows and large transfers.
- First-week analysis by [Crystal](https://crystalintelligence.com/stablecoin/ousd-stablecoin-first-week-on-chain-analysis/): the closest earlier read on placed versus used, frozen at 5 October 2026.

## The ticker

The ticker OUSD also belongs to another token, Origin Dollar. Every figure here is filtered by contract address, never by ticker. These are the four contracts, in full:

- Tempo: `0x20c0000000000000000000006a37da5c996874be`
- Ethereum: `0x9f6f3991d525015a6f8caf062c83b62fd3ac4436`
- Base: `0xb2000000000000000000002feb517dfec7415344`
- Solana: `ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB`

Solana addresses are case-sensitive. Day 0 is 2026-09-30, when OUSD began. Times are UTC.

## The verdict

The headline is one of four states. It is a judgment about the numbers, not a number itself.

| State | When |
|---|---|
| Mostly placed | Placed supply is at least 50% of supply |
| Moving | Placed supply is under 50%, and everyday volume over the last 7 days is at least 5% of supply |
| Mixed | Neither of the above, so the data doesn't support a clear statement either way |
| No clear statement | The data can't carry a sentence yet, for example because a chain is missing, a check didn't pass, or a missing issuer label could change the answer |

The thresholds are 50% (5,000 basis points) for placed and 5% (500 basis points) for everyday. They are judgments, not findings, and no published standard sets them. We chose round shares a reader can weigh at a glance: a majority of supply that has sat still, and a twentieth of supply changing hands in a week.

Moving either threshold, or the definitions below, would change the headline. So would more labels: a wallet we can't name can count as placed, so a new label for an issuer or venue wallet lowers placed supply. If removing exchange-linked placed from placed supply would move it across 50%, alone or together with the placed supply of a chain with no issuer label, the headline is No clear statement. The settings behind the thresholds are listed at the end of this page.

## Definitions

Each definition below has its own link, so a chart can point straight at it. Figures are in OUSD, with 6 decimals, and kept exact until the moment they are shown.

### Minted, burned and net issuance

Minted is the value of transfers from the zero address on EVM chains, and of mint instructions on Solana. Burned is the value of transfers to the zero address, and of burn instructions on Solana. Net issuance is minted minus burned. Test mints began before day 0.

### Issuer inventory

Supply held by wallets labeled as Bridge's, or on its redemption route. A chain with no issuer label reads zero here, and the page says so.

### Venue supply

Supply held by wallets a public source labels as an exchange, a DEX pool or a lending market. Exchange holdings are a floor: they count only named wallets. Custody no source names isn't a venue.

We can see where an exchange's named wallets send money, and not what happens inside its own ledger. Trading, rewards and client balances there are invisible, so a balance that hasn't moved on the chain may or may not be in use.

Two exchanges are confirmed to support OUSD: [Coinbase](https://www.coinbase.com/price/ousd) and [Kraken](https://blog.kraken.com/product/asset-listings/ousd-is-available-for-trading). We found no public source naming a wallet of the second that holds OUSD, as of 2026-11-04, so its amount is unknown, not zero. The [exchange holdings table](#named-labels) lists what named wallets hold. The main page shows each exchange with its source: one with named wallets gives their count and a floor, and links here for each wallet's source, as the main page holds no address. One with none says no wallet is labeled, and links to its own listing, which names no wallet.

### Placed supply

For a wallet with no issuer, venue or system label: the lowest its balance has been over the last 14 days, counted if that is at least $1M and the wallet is at least 14 days old. It measures dollars that stayed, and says nothing about why. It lags by 14 days, so it isn't charted before its first valid day.

### Exchange-linked placed

Part of placed supply, not an addition to it. A wallet counts if it has no public name, held at least $1M on 2026-11-03, took at least one transfer of $1M or more from wallets a public source names as an exchange, took every inflow of $1 or more from those wallets, and sent at most 2% of its inflows anywhere else. The list is fixed as of that day and changes only through a reviewed labels change, and it isn't re-tested after that date. A wallet could belong to the exchange, to its clients or to someone else, and the chain can't tell them apart. A wallet's funding and a label site's name are leads, not sources, so none of these is named. The site gives a count and this rule, with no address.

### Free-floating supply

Everything else: total supply minus issuer inventory, placed supply and venue supply.

### Circulating supply

Total supply minus issuer inventory and placed supply. It includes venue supply, which is shown separately.

### Headline volume

All transfer value, so it can be compared with other sources. It includes mints, burns, fees and the movements below, and so overstates use.

### Clean volume

Headline volume minus, in order: mints, burns, Tempo fees, fee liquidity, issuer flows, same-entity moves, same-transaction netting, and venue flow. Within a transaction, each address's money in and out are netted, so loops and multi-hop routes count once. Hops across several transactions still count at every hop. The parts add back to headline volume to the base unit, and a blocking check enforces that.

### Everyday and large clean volume

Clean volume split by transaction at $1M. Large transfers are mostly balances moving between wallets, though public evidence can't show that they belong to the same owner, so they are split out instead of removed. Everyday means a clean transfer under $1M, nothing more.

### Venue flow

Net flow to and from DEX and lending contracts, shown separately and including seeding. It isn't trading volume, because we ingest no swaps.

### Tempo fee

A transfer to Tempo's fee manager that is the last OUSD transfer in its transaction. Other transfers to or from the fee manager are fee liquidity. Fees make up many transfers and almost no value, so leaving them in would overstate activity.

### Velocity

Rolling 7-day clean volume divided by 7, then by circulating supply. The common definition is different: transfer volume over total supply. We show ours, an everyday version, and the common one, because they differ widely.

Quiet days, with no transfers, are rows of zeros in the activity series. Active wallets is a rolling 7-day count, so it can be nonzero on a quiet day. KPI rows exist only on days with supply.

### Velocity's two denominators

Ours divides by circulating supply, and the common one divides by total supply. Circulating supply is smaller, so ours can exceed the common one. An invented example: a chain has 1,000 of supply, of which 100 is issuer inventory and 700 is placed, so circulating supply is 200. Over 7 days it moves 140 in headline volume and 70 in clean volume. Headline velocity is 140 / 7 / 1,000 = 2% a day. Velocity is 70 / 7 / 200 = 5% a day. The clean figure is higher, though less value moved, because it is divided by a smaller base.

### Active wallets

Wallets that sent at least $1 of clean volume in the period, netted per transaction, excluding issuer, venue and system wallets. Also published at $100. These count wallets, not people.

### Concentration

The top-10 share of supply, and the number of holders above and below set sizes, per chain.

### Implied reserve income

Not in this version. When it arrives it will be an estimate, with its assumptions shown, and never a finding.

### Chain roles

For each chain: its share of supply, what it minted and burned in 30 days, its clean everyday volume, and its DEX and lending flow. The site says which chain leads on each measure. It doesn't say what a chain is "for". There is no trading measure, because we ingest no swaps.

## Reconciliation

Nothing is published unless seven blocking checks pass. Each is a machine check, and each proves less than it may sound.

| Check | What it does | What it doesn't prove |
|---|---|---|
| Each chain's mints minus burns equal its reported supply | Compares mints minus burns with the chain's own supply figure at the same block or slot, exactly | That every ordinary transfer was captured |
| Supply across chains agrees with the issuer's reported total | Adds the four chains at the moment of Bridge's own figure and compares it with Bridge's total, to the base unit | That the reserves exist. It compares two supply figures |
| Sampled wallet balances match the chain | Compares our balance for a sample of wallets with the chain's own, and proves every same-looking transfer group from its transaction. A chain with full history needs one completed census of all wallets. On Solana every wallet is checked | That wallets outside the sample are right, on a chain that isn't fully checked |
| The data model's tests pass | Runs tests for uniqueness, missing values and allowed values | That the logic is right, only that the shape is |
| Volume parts add up to headline volume | Checks the waterfall adds back to the total | That each part was classified correctly |
| A full reconciliation run passed | Requires the latest full run to have passed, and to match each chain's stored data | That nothing changed since that run |
| Every chain's data is recent | Requires each chain's newest transfer and the reconciliation to be within 36 hours | That a quiet chain is working |

The latest result is shown in the trust strip on the main page, and every chart names its as-of time. A change that looks wrong, such as a large jump in a metric, raises a warning for human review. That isn't a blocking check.

## Fact, estimate and opinion

Every chart and sentence carries one of four marks, and a card carries the weakest mark of its numbers.

| On the page | Mark | Why |
|---|---|---|
| Minted, burned, net supply, reconciliation results | Fact | Read directly from the chain, and reconciled to it |
| Headline volume, transfer counts | Fact | Read directly from the chain, and only partly covered by sampled balance checks |
| Issuer inventory, venue supply, DEX and lending flow | Inferred | Rests on published labels |
| Placed, free-floating, circulating, clean volume, everyday and large, velocity, active wallets, Tempo fees | Inferred | A written rule applied to chain data |
| The verdict sentence | Inferred, or Estimate at partial scope | States rule-based numbers, so it carries their mark |
| The verdict's estimates, such as the share of OUSD on the chains covered | Estimate | Rests on a stated assumption |
| The display sentence and the verdict's opinions | Our reading | An opinion about the facts |

On sample or preview data, "Our reading" is replaced by "Sample, not a finding" or "Preview, not a finding".

## Known limits

These are the limits of the figures. The first group travels with each dataset and changes with coverage. The second group isn't carried in the dataset. Each numeric limit gives the day it was measured. Engineering limits with no bearing on a reader's numbers, such as gaps in secret scrubbing, stay in `docs/build-log.md` in the repository.

### Limits in the dataset

- This is not a reserve attestation. It reads chain data and says nothing about the reserves. See Bridge's own reports for those.
- Placed supply measures dollars that stayed in a wallet. It doesn't show why they stayed, and the chain can't show intent.
- Everyday volume means clean transfers under $1M, nothing more. A payment can't be told from a bot or a treasury sweep.
- Clean volume nets each transaction, but a chain of transfers across several transactions counts at every hop, so it can overstate.
- Active wallets count wallets, not people.
- Issuer inventory and venue supply count only wallets a public source labels. Exchange holdings are a floor. Custody with no published label can count as placed, and some of it is marked as exchange-linked.
- Day 0 was 2026-09-30, so this is weeks of history: a direction at most, not a trend.
- Velocity divides clean volume by circulating supply, and headline velocity divides all volume by total supply. Circulating supply is smaller, so velocity can exceed headline velocity. Both denominators are published beside them.
- Each chain stops at its own last complete UTC day, so chains can end on different days. A chain's KPIs end on its last day with a transfer, and each row names its day.
- A transfer lost between two wallets, with no later rows, passes until one of them is drawn into a balance sample. On Tempo that is about 3% a run. (measured 2026-11-04)
- An error in Bridge's total that exactly equals the moves inside the comparison window matches one of the attainable sums.
- Reorg repair is tested with simulated reorgs. Solana reads finalized data only, so it has no reorg test.

The dataset adds more when coverage is partial: a chain with no wallet labeled as the issuer, a chain with no issuer label at all, a local preview, or a chain that wasn't covered.

### Limits not in the dataset

| Limit | Measured | From |
|---|---|---|
| Base balances are checked on a sample of 50 wallets a run, not a census. | 2026-11-04 | Build log, first full reconciliation |
| If Blockscout lags more than its 2,000 block tail, ordinary transfers can be missed, and only the sampled balance check would catch it. | 2026-11-03 | Build log, known gaps |
| Whether Blockscout and the RPC give the same log index for a block hasn't been checked. | | Build log, known gaps |
| Placed supply lags by 14 days, and isn't charted before its first valid day, 2026-10-14. | | Methodology |
| A few large transfers dominate clean volume: 81 Tempo transactions were 97% of its clean volume. Those inspected looked like holders moving balances between wallets, which public evidence can't confirm. | 2026-11-03 | Adoption metrics brainstorm |
| The Tempo fee rule was tested on 350 random rows with no misses, so its true miss rate is below about 0.9% by count at 95% confidence, and well under a dollar is at risk. | 2026-11-03 | Adoption metrics brainstorm |
| DEX flow isn't trading volume, and we ingest no swaps. | | Methodology |
| Bridge's small-ticket issuance is excluded from clean volume, as issuer flows are, and this version doesn't show it live. On Tempo, transfers under $100K from the hub wallet that mints go to rose from 93 in the week of 5 October to 2,441 in the week of 26 October, which may be on-ramp use. That is unproven. | 2026-11-03 | Adoption metrics brainstorm |
| A stale note appears only once a rebuild or the reader's clock shows it, so a failed run can take up to 36 hours to show on a page that wasn't rebuilt. | | Methodology |

## How we know: the source legend

Every label has exactly one source type. It tells you what kind of evidence the label rests on, and so how to check it.

| Source type | What it means | How to check it |
|---|---|---|
| `explorer_tag` | A block explorer shows this name on the address | Open the link and read the name at the top of the address page |
| `project_docs` | The documentation or app of the project that runs the contract lists it under this name | Open the link and find the name, with its address beside it |
| `company_docs` | A company's own documentation names the address as its own | Open the link and find the name, with its address beside it |
| `official_statement` | The named organization said so in an announcement or other statement | Open the link and find the name and address in the statement |
| `published_research` | A named research publisher ties the name to the address | Open the link and find the name and address. Publishers may shorten an address, as in `0x4c2c…00b8` |
| `onchain_metadata` | The chain itself records it, such as a verified contract name and its creator | Open the link and read the contract details |
| `exchange_listing` | An exchange's own page says it supports OUSD. It names no wallet, so it is never the source of a wallet's label | Open the link and find OUSD on the exchange's own page |
| `derived_rule` | No source names it. It is an unnamed cluster, found by a written rule applied to the chain's own data | Read the rule at the link. The dataset publishes no address for an unnamed cluster, so apply it to the addresses in `labels/labels.csv` in this repository |

**Reading a label:** a named label always has a web source you can open. A `derived_rule` label never has a name, because it describes what a wallet does, not who holds it. `confidence` is `medium` when the source leaves a gap, such as a vault page that shows no curator, or research that prints only a shortened address. Vault names come from the vault's creator, not from any company the name may suggest, so a name alone doesn't say who runs a vault. The 0x Settler labels rest on the verified contract name and on the creator the chain records for it, `deployer.zeroexprotocol.eth`. Tell us if a source no longer supports a label.

## Named labels

A wallet is named only when a public source ties the name to its address. Behavior that merely looks like a partner is not enough, such as a wallet that moves a lot of money. Such a wallet stays unnamed. We don't label private individuals, and we don't state guesses as fact. A label change is a reviewed change.

The table lists every named label by entity, with its category, source type, a link to the source, its confidence and the day we last confirmed the source still says this. The site shows no wallet address for a label. The source shows it. Entities are listed only as the dataset names them.

## Unnamed clusters

Some wallets can't be named, because no public source ties a name to them. We group them by what they do, with a written rule, and say nothing about who holds them.

The site shows a count by chain and category, and the rule, with no address. The addresses are in `labels/labels.csv` in the repository, not on this site, so they can't be checked from here until the repository is public.

### The rule

An unnamed cluster is a set of wallets found from the chain's own transfers by a written rule. No public source names them, so they have no name here, and the rule says nothing about who holds them.

The redemption route (`issuer_route`) has three kinds of wallet. The hub is the wallet a chain's mints go to. Path wallets are on the fixed path from the hub into burns. Collection wallets take money from many senders, send every outgoing transfer to the hub, and hold almost no balance. A wallet that passes money through from a single sender stays unlabeled, as does any other wallet with flows into the route, however large the flows. A contract on the path may have a verified name on the chain, but that name doesn't say who runs it, so the label stays unnamed.

An exchange-linked wallet (`exchange_linked`) has no public name, held at least $1M on 2026-11-03, took at least one transfer of $1M or more from wallets a public source names as an exchange, took every inflow of $1 or more from those wallets, and sent at most 2% of its inflows anywhere else. The list is fixed as of that day and changes only through a reviewed labels change, and it isn't re-tested after that date. A wallet could belong to the exchange, to its clients or to someone else, and the chain can't tell them apart. A label site's name for such a wallet is a lead, not a source, and a wallet's funding is not a source either. Its balance stays in placed supply, marked as exchange-linked.

Published data gives a count of these wallets by chain and category, with this rule. Their addresses aren't in published data or on the site. They are in `labels/labels.csv` in this repository.

## Settings in this dataset

Each setting is a single-line edit in the data model, and the dataset records the ones it was built with. A dataset built with other values isn't release grade. These are the documented defaults.

Base units have 6 decimals, so 1000000 is $1 and 1000000000000 is $1M. `active_dust_base_units` is the $1 floor for an active wallet, and `active_secondary_base_units` the $100 one. `clean_tx_min_base_units` is the $1 floor for a clean transfer to count in the clean transfer count.

### Documented defaults

| Setting | Default |
|---|---|
| `placed_days` | 14 |
| `placed_min_base_units` | 1000000000000 |
| `large_transfer_base_units` | 1000000000000 |
| `active_dust_base_units` | 1000000 |
| `active_secondary_base_units` | 100000000 |
| `clean_tx_min_base_units` | 1000000 |
| `journey_first_day` | 2026-10-14 |
| `placed_threshold_bps` | 5000 |
| `everyday_threshold_bps` | 500 |
| `velocity_bps` | `clean_7d / 7` over `circulating_supply` |
| `velocity_everyday_bps` | `clean_everyday_7d / 7` over `circulating_supply` |
| `headline_velocity_bps` | `headline_7d / 7` over `total_supply` |
