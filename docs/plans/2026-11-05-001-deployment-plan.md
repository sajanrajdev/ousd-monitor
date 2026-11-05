---
title: "plan: Host the daily run on Railway and the site on Vercel"
type: plan
status: accepted
date: 2026-11-05
origin: docs/architecture.md
---

# plan: Host the daily run on Railway and the site on Vercel

## Overview

Today the pipeline runs by hand on the maintainer's machine, and nothing is hosted. This plan moves the daily run to one Railway service with a persistent volume, and publishes the static site to Vercel. Visitors still read only static files. No remote database is added.

This is a plan only. It writes no Dockerfile or workflow, creates no account and deploys nothing. Every step that needs an account or a token is the maintainer's, and production stays switched off until he approves it.

## Decisions taken (2026-11-05)

The maintainer accepted every recommendation below.

1. **Shape:** (b) Railway cron, restart policy `Never`.
2. **Warning policy:** acknowledge by chain and metric through `OUSD_ACK_WARNING_KEYS`, starting with `ethereum:circulating_supply`. Any other warning refuses. The acknowledged keys are logged on every run. **Review date: 2026-12-05**, or at U7 if that comes first. On review the key is either kept with a new date or removed.
3. **Alerts:** Railway email notifications first.
4. **Stale rebuild on failure:** later.
5. **Branch:** Railway deploys from `dev` during the preview phase, and moves to `main` before production. This was the default proposed to the maintainer. Automatic deploys are either off (deploy by hand with "Deploy Latest Commit") or gated with Railway's "Wait for CI". Both exist; see the table below. Off is the safer default while a deploy could land during a run.
6. **Production:** promoted by hand with `vercel promote` after the reviews in U7. No automatic promotion for now.

**Settled by the maintainer, not reopened here:**

- The pipeline runs on Railway, as simply as possible, in one service.
- The site is on Vercel's Hobby plan. Visitors never reach a database.
- No backups in this version. The maintainer's local `data/ousd.duckdb` is the fallback. See [Decisions](#decisions-recorded-here).
- No remote database: no Postgres, MotherDuck or Supabase. See [Later, not now](#later-not-now).

## What was checked while planning

Railway and Vercel documentation was read on 2026-11-05. Anything below marked **unverified** was not settled by the docs and must be checked in the unit named.

| Question | Finding | Source |
|---|---|---|
| Cron schedules | A service with a cron schedule runs its start command on that schedule, in UTC, and must exit when done. If the previous run is still active, the next is skipped. Runs can drift by a few minutes. At least 5 minutes apart | docs.railway.com/cron-jobs |
| Cron runs from the CLI | `railway cron list` shows each run as `EXITED`, `CRASHED`, `SKIPPED` and so on. `railway cron run` triggers one off schedule | docs.railway.com/cli/cron |
| Can a cron service mount a volume? | The docs neither say yes nor no. A volume attaches to a service, and cron is a service setting. A Railway community thread from October 2026 describes a cron service with a volume mounted, so it works in practice. **Unverified in the docs; confirmed in U3** | docs.railway.com/volumes, station.railway.com |
| Volume limits | One volume per service. Hobby default size 5 GB, resizable up. Volumes mount at start, not during build. No replicas with a volume, and a redeploy has brief downtime because two deployments can't mount it at once | docs.railway.com/volumes/reference |
| Reaching volume files | `railway volume files upload` and `railway volume browse`, or `scp` through `railway ssh`. A Railway moderator says the service must be online to reach its files. **So seeding needs the service running, not between cron runs** | docs.railway.com/cli/volume, docs.railway.com/cli/ssh, station.railway.com |
| Volume backups | Exist: manual, or scheduled daily (kept 6 days), weekly (27 days) or monthly (89 days). Incremental, billed as volume storage. Wiping a volume deletes its backups | docs.railway.com/volumes/backups |
| Pricing | Hobby is $5 a month and includes $5 of usage. RAM $10 per GB-month, CPU $20 per vCPU-month, volume $0.15 per GB-month, egress $0.05 per GB, all billed by use. Builds are free | docs.railway.com/pricing/plans |
| Restart policy | Default `On Failure`, up to 10 restarts. `Never` is available | docs.railway.com/deployments/restart-policy |
| Alerts | Email and in-app notifications for deployment status changes, switched on in account settings. Project webhooks also exist. **Whether a `CRASHED` cron run sends one is unverified; checked in U4** | docs.railway.com/overview/production-readiness-checklist |
| Commit in the container | Railway sets `RAILWAY_GIT_COMMIT_SHA` on deploys from GitHub | docs.railway.com/variables/reference |
| Vercel prebuilt deploys | `vercel deploy --prebuilt` uploads `.vercel/output`, which needs only `config.json` with `"version": 3` and a `static/` folder for a static site. `vercel deploy` makes a preview unless `--prod` is given. stdout is the deployment URL | vercel.com/docs/cli/deploy, vercel.com/docs/build-output-api/configuration |
| First Vercel deploy | **The first deployment of a new project is always production, even without `--prod`.** This affects the rollout. See U3 | vercel.com/docs/cli/deploy |
| Keeping previews private | Vercel Authentication works on Hobby, for "Standard Protection" (all but production domains) or "All Deployments" | vercel.com/docs/deployment-protection |
| Promotion | `vercel promote <url>` makes an existing deployment current. Promoting a preview asks for confirmation and makes a new production deployment | vercel.com/docs/cli/promote |
| Automatic deploys | A service linked to GitHub deploys every push to its trigger branch, set in Service Settings. Automatic deploys can be **disabled** there; a deploy is then started by hand with "Deploy Latest Commit" from the command palette | docs.railway.com/deployments/github-autodeploys |
| Wait for CI | A service setting. Deployments sit in `WAITING` until every GitHub Actions workflow run on the commit finishes; a failed run skips the deploy, a run still unfinished after two hours skips it, and a cancelled run blocks it only if no other workflow on the commit succeeded. The toggle appears only if a workflow runs `on: push` for the branch. This repo's CI does (`push` to `dev` and `main`). Its `cancel-in-progress` concurrency means a quickly superseded commit is skipped, which is harmless here | docs.railway.com/deployments/github-autodeploys |
| Vercel CLI from the environment | **Verified.** The CLI reads `VERCEL_TOKEN` (a `--token` flag would win, and the docs recommend the variable so the token stays out of process lists and logs) and `VERCEL_PROJECT_ID`. For CI and non-interactive use, setting `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` skips project linking. `--non-interactive` turns off prompts | vercel.com/docs/cli/global-options, vercel.com/kb/guide/using-vercel-cli-for-custom-workflows |
| Hobby terms | Hobby is for non-commercial, personal use. This project is a free, independent dashboard | vercel.com/docs/plans/hobby |

And in this repo:

- `dagster job execute` exits non-zero when a run fails (`click.ClickException`), so `make run` gives a cron service a real exit code.
- `publish.py` prunes published folders to the newest 14 (`KEEP_FOLDERS`), always keeping the one `latest` points at. At about 2 MB each, the volume needs no extra pruning.
- `publish.py` reads the commit with `git rev-parse` and **refuses to publish without it**. A container built without `.git` will refuse every run. See U1.
- No headless browser is needed. Playwright is used only by `make web-shots` and `make web-acceptance`, which are local, and its browser download is a separate explicit step.
- Nothing found prints an env value. Chain URLs are `repr=False`, Dagster logs name a chain and an error class only, and `publish.py` refuses a dataset that contains any provider URL value. But see [Secrets](#secrets): the site build inherits the whole process environment.

## Railway shape

Both shapes are one service, one image and one volume mounted at `/app/data`, so `data/ousd.duckdb`, `data/marts.duckdb`, `data/published/` and `data/.dagster/` all persist.

| | (a) Always-on Dagster | (b) Railway cron |
|---|---|---|
| What runs | `dagster-daemon`, optionally the UI, with the 06:00 UTC schedule and failure sensor switched on | `make run` then the deploy step, once a day at 06:00 UTC, then exit |
| Fits the code | Uses the schedule and sensor as written | Uses `make run` as written. The schedule and sensor stay unused, as today |
| Failure alert | Sensor writes `data/alerts/<run_id>.json` on the volume. It sends nothing, so an alert still needs Railway or an email service | Run shows `CRASHED`, which Railway can email (to verify in U4) |
| One writer | The daemon queues runs. The UI could start a second run by hand, which exits 2 | Railway skips a run while the last is active |
| Seeding and file access | Easy: always online | Needs a temporary "hold" start command, below |
| Exposure | The UI must stay private: no public domain, reached by `railway ssh -L` only | Nothing listens |
| Cost (estimate) | Idle daemon memory all month, roughly $5 to $10 a month in total on Hobby | About $5 a month: the run uses well under the $5 included |

**Recommendation: (b) cron.** It is the simplest thing that runs the existing `make run` once a day, keeps nothing running, and leaves no UI to secure. Its one awkwardness, reaching the volume, only matters for seeding and recovery, and a hold command handles it. The cost estimate assumes a run of under an hour at about 2 GB peak (the site build is the heaviest step). U1 measures both. Accepted by the maintainer (decision 1).

**Restart policy must be `Never`** for the cron service. With the default `On Failure`, Railway would restart a failed run up to 10 times, and the code says a failed check is never retried. Dagster already retries source errors itself, twice, five minutes apart.

**Branch.** The service deploys from one branch: `dev` during the preview phase, `main` before production (decision 5). Railway redeploying mid-run would stop the run, as two deployments can't share the volume. DuckDB recovers, and the next run catches up from the cursor, but automatic deploys stay off, or on with "Wait for CI", so a broken commit never reaches the service.

## Container

Described, not written. One image, built by Railway from a Dockerfile in the repo:

- **Python 3.12 via uv**, with `uv sync --locked` at build, so dbt, dbt-duckdb and Dagster come from `uv.lock`. Runtime commands stay `uv run --locked`.
- **Node 22 or 24** (the range in `web/package.json`), with the pnpm version from `packageManager` fetched through `npx` at build and `web/node_modules` installed with `--frozen-lockfile`, so a run needs no registry. `make web-release` runs `web-install` again, which is then a no-op.
- **`git`**, or a commit passed in. See U1.
- **The Vercel CLI**, pinned.
- No headless browser.
- Working directory `/app`, the repo root, as every command assumes. The volume mounts at `/app/data`. No `.env` exists in the image, so the Makefile's `--env-file` is skipped and variables come from Railway.
- The process runs as root, or sets `RAILWAY_RUN_UID=0`, because volumes mount as root.

## First seeding

Production must never do a cold backfill: Ethereum history through Blockscout takes hours (see `docs/build-log.md`). So the volume starts from the maintainer's copy of `data/ousd.duckdb`, and only that file. `marts.duckdb` is rebuilt by dbt in seconds, and Dagster's state starts fresh.

1. On the laptop, stop anything that writes: no `make run`, `make sync` or `make dagster-dev` running. The upload must read a file nobody is writing.
2. Copy `data/ousd.duckdb` to a temporary file and upload the copy, not the live file.
3. On Railway, set the service's start command to a hold (for example `sleep infinity`), with no cron schedule yet, so the service is online and runs nothing.
4. Upload with `railway volume files upload <copy> /ousd.duckdb` (the volume root is `/app/data`). Optionally also upload `data/published/` so the first deploy has a last good dataset to show as stale if the first run fails.
5. Check the size matches, then restore the real start command and set the cron schedule. From this moment the Railway copy is the only writer. The laptop copy becomes the fallback and is not run against production.

## Secrets

All go into Railway service variables only, never into the repo, the image or a log:

- `BASE_RPC_URL`, `SOLANA_RPC_URL`.
- Any keyed override of the public defaults, if the maintainer uses one: `TEMPO_RPC_URL`, `ETHEREUM_RPC_URL`, `ETHEREUM_BLOCKSCOUT_URL`, `BRIDGE_API_URL`.
- `VERCEL_TOKEN`, and the project's `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` so the CLI needs no linked folder. The CLI reads all three from the environment (verified, see the table above). Pass the token by environment, never as `--token` on a command line.

The repo rule stands: **never log, print or raise an RPC URL or any part of it**, in Python, dbt, Dagster logs or build output.

**One gap to close in U1.** `web/scripts/build-site.mjs` runs `next build` with `{ ...process.env }`. On a laptop that is safe, because the site's steps never load `.env`. In a container the RPC values are in the process environment itself, so the site build inherits them. Next inlines only `NEXT_PUBLIC_*` variables and no web code reads an RPC variable, so nothing leaks today, but the safeguard the Makefile describes doesn't hold. The deploy step should run the site build and the Vercel CLI with the RPC variables removed (an allowlisted environment), and the pipeline steps without the Vercel token.

## Publish to Vercel

After a passing `make run`:

1. `make web-release`, with `OUSD_DATASET_DIR` unset so it reads `data/published/latest`. It refuses anything not release grade, and verifies the output.
2. Copy `web/.release/latest/` into `.vercel/output/static/` with `config.json` set to `{"version": 3}`, and run `vercel deploy --prebuilt`. Its stdout, the deployment URL, goes to the run log.

This differs from `vercel build` followed by `vercel deploy --prebuilt` on purpose: `vercel build` would run `next build` again without the release gate or `verify-output`. Uploading the verified folder keeps one build, the one that was checked.

**Preview only.** The deploy step never passes `--prod`. Promoting a preview to production is a separate, explicit step the maintainer runs (`vercel promote <url>`) after reviewing it. Turning on automatic production deploys is a later decision.

**Pruning.** Published datasets on the volume are already capped at 14 folders by `publish.py`. Vercel keeps old preview deployments. That's harmless at one a day, but the maintainer may want a retention setting later.

## Failure path

- **A failed check publishes and deploys nothing.** `make run` exits non-zero, the deploy step doesn't run, and the live site keeps the last good data. This is the existing design.
- **Stale data shown as stale.** The site already does this in two ways. At build, a manifest marked stale shows "A newer run did not pass its checks." In the reader's browser, `FreshnessWatch` flips the page to stale once the data is past the 36 hour limit, with no rebuild. So with no rebuild, a failed run shows on the live site within 36 hours at most (methodology already says so).
- **What would rebuild with the stale banner?** Today, nothing: a failed run marks `data/published/latest` stale on the volume, but nobody builds from it. Option, for the maintainer: on a failed run whose checks marked the dataset stale, build and deploy that stale-marked dataset, so the banner appears the same day. It deploys no new numbers. Not every failure marks the dataset stale (a sync error after retries, or a `StoreConflict` during sync, doesn't), so the 36 hour clock remains the backstop. Recommended for a second step, not the first.
- **Alerting.** First: Railway's email notifications for deployment status, plus `railway cron list` showing `CRASHED`. U4 checks that a crashed cron run actually sends an email. If it doesn't, a Railway project webhook is next, and an email service is later. In the cron shape the Dagster failure sensor doesn't run, so `data/alerts/` stays empty.

## The known Ethereum warning

`make web-release` refuses while the dataset has warnings, unless `OUSD_ACK_WARNINGS` equals that dataset's version. Every recent dataset carries one warning, Ethereum `circulating_supply`, because the warning compares each chain's newest day with the day before, and Ethereum's circulating supply is small and moves a lot. Its day changes with every run, and the version changes with every dataset, so neither can be acknowledged ahead of time. An unattended run would refuse every day.

**Accepted (decision 2):** acknowledge the known warning by **chain and metric**, not by day or version. For example a variable `OUSD_ACK_WARNING_KEYS=ethereum:circulating_supply`. The release prints every warning as now, passes if every warning's key is listed, and refuses on any other warning. Two guards: list the acknowledged key in the run log every time, and give it a review date in this plan's follow-up, so it doesn't become permanent by default. A new warning on any chain or metric still stops the deploy and alerts. This changes `web/scripts/build-site.mjs` and its tests.

Alternatives: keep the per-version acknowledgement and let the daily run deploy previews only when there are no warnings (in practice, never); or acknowledge every warning automatically for previews only, and require the per-version acknowledgement at promotion. The second keeps a human on production but means production is rebuilt by hand.

## Rate limits from cloud IPs

Blockscout's free limit and the public RPCs may treat Railway's shared egress IPs worse than a home connection. A daily run fetches only blocks since the cursor, a small amount, so the risk is mostly the first runs. The U4 dry run checks this on purpose and reads the log for 429 pauses (each pause of 5 seconds or more is logged).

If it fails: the run retries twice, then fails and deploys nothing. Next steps, in order: rerun later to rule out a burst; move the Railway region; give Ethereum a keyed RPC for the tip; and, only if Blockscout itself refuses, find a keyed history source. Any new provider is a reviewed change to `sources`.

## Implementation units

### U1 Container and deploy step

Dockerfile and one entry point (for example `scripts/daily.sh` or a `make daily` target) that runs `make run`, then on success the release and the preview deploy, with the environments split as in [Secrets](#secrets).

Also settles the commit: either keep `.git` in the image, or let `publish.py` take a commit from a variable (for example `OUSD_GIT_COMMIT`, filled from `RAILWAY_GIT_COMMIT_SHA`) when `git` isn't available. The second touches `publish.py`, so it needs the extra review.

**Done when:** a local container run on a **copy** of `data/` (never the live folder) passes `make run`, builds the release, and with a throwaway Vercel project the maintainer created, produces a preview URL. Peak memory and run time are written down. `make check` passes. No env value appears in the container's output.

### U2 Warning policy

The chosen policy in `build-site.mjs`, with tests: a listed key passes, an unlisted warning refuses, no warning needs nothing.

**Done when:** tests cover all three, and `make check` passes.

### U3 Railway and Vercel setup (maintainer)

The maintainer creates the Railway project and service in his own account, the volume at `/app/data`, the variables, the restart policy `Never`, and email notifications. On Vercel he creates the project, turns on Vercel Authentication for **All Deployments** before the first deploy (because the first deploy is always production), and makes a token scoped as narrowly as Vercel allows. Then seeding as above.

**Done when:** the volume holds `ousd.duckdb` at the right size, the service starts with the volume mounted, and the Vercel project exists with protection on.

### U4 Dry run on Railway

One run triggered with `railway cron run` on the seeded volume, deploying to a preview.

**Done when:** the run exits 0, its catch-up and run time are recorded, the log shows no 429 storm and no env value, a preview URL exists and shows the new data-as-of time. Then one deliberate failure (for example a missing `SOLANA_RPC_URL`, which fails before any data is touched) shows `CRASHED`, deploys nothing, and sends the maintainer an email.

### U5 Scheduled preview runs

Three to seven days of 06:00 UTC runs, all to preview.

**Done when:** each run either deploys a preview or fails with an alert and no deploy, and the volume stays small.

### U6 Docs

Fix the docs listed below, in the same PR that lands the deployment.

### U7 Production (maintainer)

Only after the maintainer's whole-page review, Phase 4's U6 acceptance (`docs/plans/2026-11-04-002-dashboard-refurbish-plan.md`), the Phase 4 claim review (`docs/implementation-plan.md`), and his explicit approval. He promotes a reviewed preview with `vercel promote`, switches production protection to Standard, and decides whether later runs promote automatically.

## Rollout

1. U1 and U2 merged, local container run passes.
2. U3 setup and seeding, by the maintainer.
3. U4 dry run to preview.
4. U5 scheduled preview runs.
5. U6 docs.
6. U7 production, only on the maintainer's approval.

## Docs that are wrong today

To fix in U6, not in this PR:

- `docs/architecture.md` lists DefiLlama as a source. Nothing in `pipeline/` uses it.
- `docs/architecture.md` says the site is "on Vercel's free tier". Nothing is hosted yet.
- `docs/architecture.md`'s "Blocking checks" lists six checks. The code (`CHECK_NAMES`), the README and the methodology have seven: `reconciliation_gate` is missing.
- `docs/architecture.md`'s "Known gap: no cloud hosting" and "the schedule and failure sensor ship stopped" change once this lands.
- `README.md` says browser acceptance is done. That was true of Phase 3, not of the redesigned page, whose acceptance is Phase 4's U6.
- `docs/implementation-plan.md` puts hosted schedules in Phase 5. This plan brings them forward, behind preview only.

## Decisions recorded here

- **No backups in this version.** If the Railway volume is lost, reseed from the maintainer's local `data/ousd.duckdb` and let the cursor-based ingest catch up. Trade-off: the local copy ages from the day of seeding unless refreshed, and the catch-up grows with the gap. Tempo, Base and Solana catch up through RPC; Ethereum history beyond the RPC window goes through Blockscout's tight free limit, so a gap of weeks may take hours, as a cold backfill does. Until it finishes, no run publishes, and the live site goes stale by the clock. A zero-code option for later: Railway's own scheduled volume backups (daily, kept 6 days), billed as storage. They live with the volume, so they don't protect against losing the project.
- **One Railway service, cron shape recommended**, with restart policy `Never`.
- **Deploy the verified release folder** with `vercel deploy --prebuilt`, not a second `vercel build`.
- **Preview only** until the maintainer promotes.
- **Site build and Vercel CLI run without RPC variables** in their environment.

## Later, not now

- **Postgres:** a remote warehouse isn't needed while one file and one writer work.
- **MotherDuck:** the natural next step for DuckDB if a remote database is ever needed.
- **Supabase:** no use for its auth or API, and visitors never read a database.
- **Volume backups:** Railway's scheduled backups, when the maintainer wants them.
- **Email alerts service:** only if Railway's notifications prove not enough.
- **Stale rebuild on failure:** see [Failure path](#failure-path).

## Decisions for the maintainer

Items 1 to 6 were settled on 2026-11-05; see [Decisions taken](#decisions-taken-2026-11-05). What remains:

1. **Review of the acknowledged warning key** by 2026-12-05, or at U7.
2. **Whether Railway automatic deploys are off or gated on "Wait for CI"** during the preview phase.
3. **Setup only he can do:** Railway account, project, service, volume and variables; Vercel account, project, protection and token; the seeding upload. All in his name.
