# Open USD Monitor: PRD

**Status:** the first version is live. Views C, D and F are still to come (see [the roadmap](roadmap.md)).
**Written:** 2026-11-03, with figures as of that date.

Open USD Monitor is an independent project, not affiliated with Open Standard, Bridge or any partner.

## 1. The question

A supply and holders dashboard is not worth building. That ground is already covered well (section 4).

A dashboard that answers one question is worth building:

> **Open USD pays partners to distribute it. Is that turning into money that moves, or is it still balance-sheet supply waiting for demand?**

No public source tracks this continuously with labeled, cleaned data. That is the contribution this project can make.

## 2. Goals

1. **Transparency:** give anyone following OUSD, including partners, businesses evaluating it, researchers and the wider community, an honest, sourced read on adoption.
2. **Trustworthy engineering:** build on raw chain data with reconciliation, tests and open methods, so anyone can check the numbers.

If the two ever conflict, accuracy wins. A smaller correct dashboard beats a bigger one.

## 3. What is special about OUSD

Figures are as of 2026-11-03 unless noted. The on-chain and reserve figures were read directly from each chain and Bridge's API that day.

| Difference | What it means | What the data should show |
|---|---|---|
| **Partners earn the economics.** Reserve earnings pass to partners, minus a management fee, instead of staying with the issuer. Rewards are proportional to supply and activity driven, and partners can earn equity | The product is a distribution program. Circle pays for distribution one negotiated deal at a time; OUSD makes it the default | Who is actually driving supply and activity, and what the reserve pool could be worth |
| **Issuer and governor are separate.** Bridge issues; Open Standard, owned by founding partners and governed by a partner board, operates the network | The first real test of whether a neutral consortium beats a single issuer. Global Dollar (USDG) is a consortium precedent that Coin Metrics says has not gained similar traction | Comparison with peers at the same age |
| **Free mint and burn, no volume limits**, through Stripe, Coinbase, BVNK (Mastercard) and the Visa Stablecoin Platform | Supply should track business demand directly. Issuance bursts and redemptions are a direct signal | Mints, burns and net issuance over time, by chain |
| **Native on four chains, weighted to Tempo.** Tempo holds 67% of supply and OUSD on Tempo is Stripe's default | Unusually concentrated on a new payments chain, where the raw numbers mislead (next row) | Each chain's role, not only its balance |
| **Tempo pays fees in stablecoins.** Fee payments appear as token transfers. Crystal found 8,377 of 11,544 Tempo transfers in week one were fees worth $3.33 in total, and 60% of non-fee volume involved Bridge's own wallet | Headline activity overstates use | Clean activity, shown next to the headline number |
| **Backed by Treasuries and cash, with a public API.** $874.2M reserves against 872.2M supply: 88.65% Treasuries, 11.35% cash, 100.23% coverage | Reserve income is the prize partners share | Implied reserve income as a labeled estimate |

**Current supply:** 872.2M OUSD: Tempo 588.6M, Ethereum 112.6M, Base 90.9M, Solana 80.1M. It was 666.3M on October 5, per Crystal, so it has grown about 31% in four weeks. Where that growth went is the question.

**Trap:** the ticker OUSD also belongs to Origin Dollar, a 2020 DeFi token. Always filter by contract address and write "Open USD (OUSD)".

## 4. What already exists

| Source | Covers | Doesn't cover |
|---|---|---|
| [`zcabrams` Dune suite](https://dune.com/zcabrams/ousd-master): Health, Trends, Chains, DeFi, Holders & Flows, Transaction Monitor, Liquidity Health | Very thorough: supply, holders, pools, peg, flows, dormancy, large transfers | Third parties are neutral codes (C1, C2) with a private map, and it has no narrative for outsiders. The handle matches Zach Abrams's X handle, but authorship is unconfirmed |
| [ousd.fyi](https://ousd.fyi/) | Reserves against supply, per-chain supply, Tempo transfer volume | Adoption quality; volume looks to be the raw figure |
| [Bridge transparency API](https://transparency.bridge.xyz/v0/stablecoins/ousd) and reserves page | Issuer-reported supply and reserves | Activity |
| [DefiLlama](https://defillama.com/stablecoin/open-usd), [Token Terminal](https://tokenterminal.com/explorer/projects/openstandard/openusd) | Supply and market cap history | Who holds it, or why |
| [Crystal first-week analysis](https://crystalintelligence.com/stablecoin/ousd-stablecoin-first-week-on-chain-analysis/) | The best read on this question: placed versus used | One article, frozen at October 5 |
| Coin Metrics, CoinShares | Model and market analysis | Live OUSD adoption data |

**The gap:** Crystal's question, answered continuously and in public, with named entities where public evidence supports them, plus peer benchmarks and the partner lens.

**Don't compete on:** live supply, reserve coverage or pool health. Link to those sources instead.

## 5. Non-goals

Price or trading signals; reserve attestation; replacing the sources in section 4; real-time alerts; other chains beyond the four; a token or paid product; wallet-level doxxing.

## 6. Product

One page that reads top to bottom as an argument, then a methodology page. First viewport: the answer in one sentence, a few numbers and a data-as-of time.

| View | Question | Why it's specific to OUSD |
|---|---|---|
| **A. Supply journey** | Of what was minted, how much is placed, distributed, circulating and active? | Launch liquidity was committed by partners, so placement isn't demand |
| **B. Real activity** | How much of the headline transfer volume is real? Show it as a waterfall | Tempo fee transfers and Bridge's flows distort it |
| **C. Partner tracker** | Of 200+ partners, who has public evidence of going live, and who has a visible on-chain footprint? | The model only works if partners activate. Nobody publishes this |
| **D. Peers by age** | Against USDG, PYUSD, USD1 and RLUSD at the same days since launch, how does OUSD compare on supply, holders and velocity? | Tests the consortium claim fairly. Comparing it with USDC today says nothing |
| **E. Chain roles** | Is each chain used for issuance, storage, settlement or trading? | Tempo holds most supply, while first-week trading was mainly on Solana and Base |
| **F. Partner economics** | What could the reserve pool be worth at current supply? | The whole model rests on this. Estimate only, with assumptions visible |
| **Trust strip** | Do our numbers reconcile? | Mints minus burns against `totalSupply()` on every chain, then against Bridge's total |

**How the first version words views A and E.** View A shows *active* as a separate measure, not a slice of the supply stack: volume and wallets aren't parts of a balance. The stack is issuer inventory, placed, venues and free-floating, with clean volume and active wallets beside it. View E says what each chain *leads* in (supply, issuance, everyday use, DEX flow, lending flow), and never calls a chain a "trading" or "settlement" chain, because the pipeline ingests no swap events and so can't show it. Both choices keep the site from saying more than the data does. [The methodology](methodology.md) gives each definition.

Also: a short written "what changed this week" note, for sharing and for readers who want the summary without the charts.

## 7. Metric definitions

Tested against real data on 2026-11-03 for Tempo and part of Ethereum: Base and Solana may still change them. Publish every one on the methodology page.

| Metric | Definition |
|---|---|
| **Minted, burned, net issuance** | Transfers from and to the zero address on EVM chains; mint and burn instructions on Solana. Day 0 is 2026-09-30, though test mints began earlier |
| **Issuer inventory** | Held by wallets labeled as Bridge's or on its redemption route |
| **Venue supply** | Held by wallets a public source labels as an exchange, DEX pool or lending market. Exchange holdings are a floor: they count only named wallets. Custody no source names isn't a venue |
| **Exchange-linked placed** | The part of placed supply in wallets with no public name that held at least $1M on 2026-11-03, took at least one transfer of $1M or more from wallets a public source names as an exchange, took every inflow of $1 or more from those wallets, and sent at most 2% of their inflows anywhere else. The list is fixed as of that day. Shown inside placed and found by a written rule. An unnamed cluster: it doesn't say who holds a wallet or what the balance is for |
| **Placed supply** | For a wallet with no issuer, venue or system label: the lowest its balance has been over the last 14 days, counted if that is at least $1M and the wallet is at least 14 days old. Measures dollars that stayed, and says nothing about intent |
| **Free-floating supply** | Everything else: total minus issuer inventory, placed and venue |
| **Circulating supply** | Total minus issuer inventory and placed. So it includes venues, shown separately |
| **Headline volume** | All transfer value, for comparison with other sources |
| **Clean volume** | Headline minus, in order: mints, burns, Tempo fees, fee liquidity, issuer flows, same-entity moves, same-transaction netting, and venue flow. Within a transaction, each address's in and out are netted, so loops and multi-hop routes count once. Hops across transactions still count more than once |
| **Everyday and large clean volume** | Clean volume split by transaction at $1M. Large transfers are mostly balances moving between wallets, though public evidence can't show that they're the same owner, so they're split out instead of removed |
| **Venue flow** | Net flow to and from DEX and lending contracts, shown separately and including seeding. It isn't trading volume |
| **Tempo fee** | A transfer to the fee manager that is the last OUSD transfer in its transaction. Other transfers to or from the fee manager are fee liquidity |
| **Velocity** | Rolling 7-day clean volume divided by 7, then by circulating supply. Differs from the common definition (transfer volume over total supply). Show ours, the everyday version and the common one, as they differ widely |
| **Active wallets** | Sent at least $1 of clean volume in the period, net per transaction. Unlabeled, exchange and exchange-linked wallets count. Issuer, issuer route, system, DEX and lending wallets don't. Also published at $100. Wallets, not people |
| **Concentration** | Top-10 share and holders above and below set sizes, per chain |
| **Implied reserve income** | Treasury share of reserves times a stated yield, plus cash at a stated rate. Illustrative example: 872M at 4% is about $35M a year. The management fee is undisclosed, so show a range |

## 8. Requirements

### Pipeline
- **R1. Ingestion:** raw OUSD transfer logs from Ethereum, Base and Tempo over RPC, and token activity on Solana, from first mint onward. Peer data may start from a vendor or Dune.
- **R2. Idempotent backfill:** re-running any range changes nothing.
- **R3. Reorg handling:** store block hashes, re-check a lookback at the tip, and replace orphaned data. Use each chain's finality signal. Reorgs may be rare here, so test the logic with simulated reorgs and say so.
- **R4. Modeling:** dbt from raw to staging to marts, with tests and documentation.
- **R5. Orchestration:** one daily Dagster job, `make run`, with retries on source errors and an alert file on failure. The Dagster schedule ships stopped; the hosted daily run is a Railway cron job that runs the same job (see [operations](operations.md)). Ingest is cursor-based and idempotent, so it doesn't use partitions (see `docs/architecture.md`).
- **R6. Reconciliation checks, which block publishing:** per chain, mints minus burns must equal `totalSupply()` at the same block, to the base unit, and balances must match `balanceOf` for sampled wallets. The chain total should match Bridge's figure within a stated timing tolerance.
- **R7. Labels:** a versioned file with address, entity, source type, source and confidence for every label.
- **R8. Freshness:** at least daily, with "data as of" visible. Show the last good data if a check fails.

### Dashboard
- **R9.** Static site reading from a published dataset, with no database calls from visitors.
- **R10.** Every chart has a one-sentence takeaway, a source, a data-as-of time and a link to its definition.
- **R11.** Works on mobile. Follows `docs/design-system.md`.
- **R12.** Numbers can be downloaded as CSV.
- **R13.** Shows "independent, not affiliated" and "not financial advice" permanently.

### Documentation
- **R14.** README and methodology a stranger can follow. A short decision record for the node provider and data vendor choice, buy versus build.
- **R15.** A half-page weekly note written for an executive.
- **R16.** A public record of lessons learned: what went wrong and what changed as a result ([lessons learned](build-log.md)).

## 9. Integrity rules

- **Public sources only.** Labels may come from explorer tags, project and company documentation, official statements, published research or on-chain contract metadata. Every label records its source type, URL and the date it was checked. The site and methodology page carry the source legend from `labels/README.md`, so a reader can see how we know each label.
- **No naming by inference.** A source must tie the name to the address. A wallet that only looks like a partner stays an unnamed cluster, and private individuals are never labeled.
- **Names on the main page.** Only an exchange's name, and only beside its source: a source tying the name to its wallets, or its own listing with "no wallet labeled". Every other labeled name stays on the methodology page, and no wallet in the unnamed exchange-linked band is named.
- **Separate fact, estimate and opinion** visibly. Anything derived from an assumption says so.
- **Stay neutral.** Report what the data shows, good or bad, with no predictions about partners.
- **It isn't an attestation.** Say so, and link to Bridge's reports.

## 10. Success criteria

- All four chains reconcile, visibly, every day.
- Someone unfamiliar with OUSD understands the answer from the first screen.
- A skeptical reader can trace any number to its definition, source and code.
- Partners and analysts can use the data and the methods with confidence.

## 11. Risks

| Risk | Response |
|---|---|
| Wrong labels or a public error | Section 9, the integrity rules; start small; independent review before publishing |
| Perceived as official | Clear disclaimer, and design that takes cues without copying (see design system) |
| Read as criticism of Open Standard or its partners | Neutral framing and visible methods |
| Mostly placed supply means little to show | That is itself the finding. Track when it changes |
| Free RPC limits on history | Short history helps. Prefer free tiers |
| Scope exceeds the time available | The first release is views A, B and E; the rest is optional |
| Open Standard's promotion rules exclude the EEA | Data isn't obviously promotion, but avoid promoting the coin. Check before launch |

## Sources

- [Open Standard: OUSD is live](https://joinopenstandard.com/blog/ousd-is-live/) and [homepage](https://joinopenstandard.com/)
- [Bridge: OUSD overview](https://apidocs.bridge.xyz/overview) and [transparency API docs](https://apidocs.bridge.xyz/platform/issuance/reporting-and-transparency)
- [Stripe: OUSD is now the default stablecoin](https://stripe.com/blog/ousd-now-live-on-stripe)
- [Tempo: OUSD on Tempo](https://tempo.xyz/developers/docs/guide/ousd)
- [Crystal: first-week on-chain analysis](https://crystalintelligence.com/stablecoin/ousd-stablecoin-first-week-on-chain-analysis/)
- [Coin Metrics via Talos: is OpenUSD a threat?](https://www.talos.com/insights/is-openusd-a-threat-to-the-dominance-of-circle-and-usdc)
- [CoinShares: what is Open USD?](https://coinshares.com/us/insights/research-data/what-is-open-usd-and-what-does-it-mean-for-stablecoins/)
- [Yahoo Finance: OUSD goes live](https://finance.yahoo.com/markets/crypto/articles/ousd-stablecoin-goes-live-visa-212301843.html)
- [Dune: a behavioral map of stablecoins](https://dune.com/blog/behavioral-map-of-stablecoins)
- [Memeburn: the ticker clash](https://memeburn.com/open-usd-ousd-explained/)
