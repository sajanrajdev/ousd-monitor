# Deploying the daily run

How the hosted run is set up: one Railway cron service that runs the pipeline once a day and deploys a Vercel **preview** of the verified site. The plan and its decisions are in `docs/plans/2026-11-05-001-deployment-plan.md`. Production is promoted by hand, never by this run.

## What runs

`scripts/daily.sh` (also `make daily`), from the image built by the `Dockerfile` at the repo root:

1. `make run`, the whole pipeline. Its environment has the Vercel variables removed.
2. On success, `make web-release`, with an allowlisted environment: no RPC variable reaches the site build. It refuses anything that isn't release grade, and any warning that isn't acknowledged.
3. On success, the verified `web/.release/latest` is copied into `.vercel/output/static` with `config.json` set to `{"version": 3}`, and `vercel deploy --prebuilt --non-interactive` uploads it as a preview. The CLI gets the same allowlist plus the three Vercel variables. It never gets `--prod`, and the token is never on a command line. The CLI prints a JSON result; `scripts/deploy-result.mjs` reads it, logs the preview URL, logs Vercel's reason on a failure, and **fails the run if the deployment landed in production** (which a new project's first deploy does).

Any failure exits non-zero and stops there: a failed run releases and deploys nothing, and the live site keeps the last good data. A run that passes but publishes no new dataset also stops before the release. The run refuses to start if `OUSD_PUBLISHED_DIR` or `OUSD_DATASET_DIR` is set, as the site only reads the default path.

The allowlisted steps fail closed: if the environment can't be listed, or holds a variable that can't be removed (such as one whose name isn't a shell identifier), they don't run.

With `OUSD_DEPLOY=0` the run builds and verifies the release but doesn't deploy, and the log says so. Off Railway, a missing `VERCEL_TOKEN` does the same, for local tests. On Railway (where `RAILWAY_ENVIRONMENT_ID` is set) a missing token fails the run, so a deleted token can't stop deploys silently. `OUSD_DEPLOY` must be `0` or `1`.

## Railway service settings

| Setting | Value |
|---|---|
| Source | This GitHub repo, branch `dev` during the preview phase, `main` before production |
| Builder | Dockerfile (the `Dockerfile` at the repo root) |
| Start command | `scripts/daily.sh` |
| Cron schedule | `0 6 * * *` (06:00 UTC) |
| Restart policy | `Never` |
| Volume | One volume, mount path `/app/data` |
| Automatic deploys | Off (deploy with "Deploy Latest Commit"), or on with "Wait for CI" |
| Public networking | None. Nothing listens |
| Notifications | Email for deployment status, in account settings |

The image runs as root, so the volume, which mounts as root, is writable without `RAILWAY_RUN_UID`. The Dockerfile has no `VOLUME` line, as Railway refuses it.

## Railway variables

Names only. Values go into the service's variables in Railway and nowhere else.

| Variable | Needed | What it is |
|---|---|---|
| `BASE_RPC_URL` | Yes | Base RPC endpoint. No public default |
| `SOLANA_RPC_URL` | Yes | Solana RPC endpoint. No public default |
| `TEMPO_RPC_URL` | Optional | Overrides the public Tempo default |
| `ETHEREUM_RPC_URL` | Optional | Overrides the public Ethereum default |
| `ETHEREUM_BLOCKSCOUT_URL` | Optional | Overrides the public Blockscout default |
| `BRIDGE_API_URL` | Optional | Overrides the public bridge API default |
| `OUSD_ACK_WARNING_KEYS` | Yes | `ethereum:circulating_supply`. Comma-separated `chain:metric` warnings the release lets through. Review by 2026-12-05 |
| `VERCEL_TOKEN` | Yes, to deploy | A Vercel token, scoped as narrowly as Vercel allows |
| `VERCEL_ORG_ID` | Yes, to deploy | The Vercel team or account ID |
| `VERCEL_PROJECT_ID` | Yes, to deploy | The Vercel project ID |
| `OUSD_DEPLOY` | Optional | `0` builds the release without deploying. Only `0` or `1` |
| `OUSD_GIT_COMMIT` | No, leave unset | The commit recorded in the dataset, for local runs. On Railway the entry point always sets it from `RAILWAY_GIT_COMMIT_SHA` |

Railway sets `RAILWAY_GIT_COMMIT_SHA` itself on deploys from GitHub. The image has no `.git` and no `git`, so `pipeline/ousd/publish.py` reads the commit from `OUSD_GIT_COMMIT`, which `scripts/daily.sh` fills from `RAILWAY_GIT_COMMIT_SHA`. A deploy that isn't from GitHub (for example `railway up`) has no commit, and publish refuses every run. That is intended: a dataset that can't be traced isn't published. The fallback in `publish.py` lands in its own PR, as the file is security-sensitive; until it merges, the image refuses to publish.

Leave `OUSD_DB_PATH`, `OUSD_MARTS_DB_PATH`, `OUSD_PUBLISHED_DIR` and `OUSD_DATASET_DIR` unset: the defaults point into `/app/data`.

## Vercel project

Create the project, then turn on Vercel Authentication for **All Deployments** before the first deploy: a new project's first deployment is always production, even without `--prod`. The CLI reads `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` from the environment, so no linked folder is needed. It doesn't create a missing project in non-interactive mode.

To promote a reviewed preview, after the reviews the plan lists under U7: `vercel promote <preview-url>`.

## First seeding

Production never does a cold backfill. The volume starts from a copy of the maintainer's `data/ousd.duckdb`:

1. On the laptop, stop anything that writes: no `make run`, `make sync` or `make dagster-dev`.
2. Copy `data/ousd.duckdb` to a temporary file. Upload the copy, not the live file.
3. On Railway, set the start command to `sleep infinity` with no cron schedule, so the service is online and runs nothing.
4. `railway volume files upload <copy> /ousd.duckdb` (the volume root is `/app/data`). Optionally upload `data/published/` too, so the first deploy has a last good dataset to show as stale if the first run fails. If you do, check with `railway ssh` that `/app/data/published/latest` is still a symlink, not a folder: publish replaces the symlink and fails on a folder. If in doubt, leave `published/` out.
5. Check the size matches. Then set the start command back to `scripts/daily.sh` and the cron schedule to `0 6 * * *`. From then on the Railway copy is the only writer, and the laptop copy is the fallback.

## Local test

Build and run the image against a **copy** of `data/`, never the live folder, with the deploy off:

```sh
docker build -t ousd-monitor-daily .
cp -R data /tmp/ousd-data-copy
docker run --rm -v /tmp/ousd-data-copy:/app/data \
  -e BASE_RPC_URL -e SOLANA_RPC_URL -e OUSD_ACK_WARNING_KEYS=ethereum:circulating_supply \
  -e OUSD_GIT_COMMIT="$(git rev-parse HEAD)" -e OUSD_DEPLOY=0 \
  ousd-monitor-daily
```

`-e NAME` with no value passes the variable from your shell, so no value is on the command line.
