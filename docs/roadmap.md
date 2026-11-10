# Roadmap

What is built, what comes next and what is known to be missing. Requirements are in [the PRD](PRD.md), and the structure is in [the architecture](architecture.md).

## Done

- **Trustworthy core.** All four chains (Tempo, Ethereum, Base and Solana) are ingested, and reconcile to `totalSupply()` to the base unit. The four-chain total matches Bridge's reported total. The first full pass was on 2026-11-04, and [lessons learned](build-log.md) has its figures.
- **Models and checks.** dbt models (supply journey, exchange holdings, activity waterfall and KPIs, chain roles and reconciliation) with tests, contracts and docs. Seven blocking checks stop publishing when any fails, and the last published dataset is marked stale.
- **Orchestration and operations.** One daily Dagster job, failure alerts and a success heartbeat, run limits, schema migrations, and manual backup and restore. See [operations](operations.md).
- **The site.** A static dashboard with the verdict, trust strip, supply journey (view A), real activity (view B), chain roles (view E) and a methodology page. It builds from a published dataset and passes the browser checks at phone and desktop widths.
- **Hosting.** The daily run is live on Railway: a cron job at 06:00 UTC runs the pipeline, builds a verified release, deploys a Vercel preview and promotes it to production when every step has passed. See [deploying the daily run](deploy.md).

## Next

- **Partner evidence (view C).** Which partners show public evidence of going live, and which have a visible on-chain footprint. A partner is named only when a public source ties the name to the evidence. The mart is `mart_partner_evidence`.
- **Peer benchmarks (view D).** OUSD against comparable stablecoins at the same days since launch, on supply, holders and velocity. The mart is `mart_peer_benchmarks`. Peer data may come from a vendor or a public dashboard, and the choice is recorded when it is made.
- **Partner economics (view F).** An illustrated estimate of what the reserve pool could be worth, with its assumptions shown. The mart is `mart_partner_economics`. It is always labeled as an estimate.
- **CSV downloads and a weekly note** for readers who want the summary without the charts.
- **Another host.** Moving the daily run off Railway is possible. Only the service settings would change: the pipeline, the image and `scripts/daily.sh` are not tied to it.

## Known gaps

- **Not every ordinary transfer is proven.** Reconciliation proves supply and a sample of balances. A transfer lost between two wallets that no later row touches passes until one of them is drawn into a sample.
- **Solana has no reorg test.** It reads finalized data only, so there is nothing to simulate. Reorg repair on the other chains is tested with simulated reorgs.
- **Hosted backups are not enabled.** The raw store is backed up by hand. A lost volume is rebuilt from the chains, which takes hours, or restored from a manual copy.
- **A static page cannot show a failed run by itself.** After a failed run the site keeps the last good data and shows its age, but it warns only once that data is more than 36 hours old.
- **Exchange holdings are a floor.** Only wallets that a public source names count, and the amount held by Kraken is unknown.
- **No trading measure.** The pipeline ingests no swap events, so the site does not say which chains are used for trading.
- **Not tested.** A real screen reader, a physical touch device, and a live refused publish on real data.
