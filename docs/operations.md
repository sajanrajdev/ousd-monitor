# Operations

How to run the pipeline, what its exit codes mean, and how to keep it healthy. For what each stage does and why, see [the architecture](architecture.md). For the hosted daily run on Railway, see [deploying the daily run](deploy.md).

## Running it locally

You need [uv](https://docs.astral.sh/uv/), which installs Python 3.12 and the dependencies. The site also needs Node 22.12+ or 24, and npm. The optional endpoint overrides `TEMPO_RPC_URL`, `ETHEREUM_RPC_URL`, `ETHEREUM_BLOCKSCOUT_URL`, `BRIDGE_API_URL` and `OUSD_MARTS_DB_PATH` (see `.env.example`) default to public endpoints and the `data/` folder.

`make check` runs lint, types and tests for the pipeline and the site with no chain access and no `.env`. A clean install does reach package registries.

### From chain data to a published dataset

Do these in order the first time:

```sh
make sync                                                                          # ingest transfers to the tip, repairing any reorg
uv run --locked --env-file .env ousd reconcile --census tempo --census ethereum    # the first full reconcile reads every wallet too
make models                                                                        # dbt: raw to staging to marts, with tests
make publish                                                                       # run the checks, then publish only if all pass
```

Later runs skip the census: `make sync`, `make reconcile`, `make models`, `make publish`. Or run everything in one process:

```sh
make run          # ingest, reconcile, dbt, seven checks, publish
make dagster-dev  # the Dagster UI, to switch on the daily schedule
```

Reconcile straight after sync, because public Ethereum nodes only serve about 100 blocks of past state.

**First sync timing.** The first Ethereum sync can take hours: Blockscout's free tier allows few requests per window, and the client waits each window out, logging every pause of 5 seconds or more. An interrupted sync resumes where it stopped. The first Solana backfill took about three hours across two runs on a keyed provider.

### Keys

Tempo and Ethereum have public default endpoints. Base and Solana have none, so `make sync`, `make reconcile` and `make run` need a keyed RPC URL for each, `BASE_RPC_URL` and `SOLANA_RPC_URL`, in `.env`. Copy `.env.example` to `.env`. `SOLANA_RPC_URL` is a Solana mainnet URL, key included, and a devnet URL is refused. Keys live only in `.env`, which git ignores, and never reach logs or errors. Solana reads only finalized data, runs first when no `--chain` is given, and does not support `reconcile --at-block`.

To run the public chains alone: `uv run --locked ousd --chain tempo --chain ethereum sync`, and the same for `reconcile`. That is a partial check and cannot publish a release.

### One writer at a time

`sync`, `reconcile`, `models`, `publish`, `run`, `backup`, `restore` and `migrate` all use the same DuckDB file, `data/ousd.duckdb` (git ignores `data/`). DuckDB allows one writer per file, and readers can share the file only with other readers. The second process to start exits 2 with "database in use". That holds in both directions: a reader started while a writer runs exits 2, and so does a writer started while a reader runs.

`ousd publish` only reads the file. `ousd check` reads it, then opens it as a writer only for the one write that records its results. `make models` writes `data/marts.duckdb` and attaches `data/ousd.duckdb` read-only, which still needs the file free of a writer.

## Reconciliation and exit codes

`make reconcile` checks supply against `totalSupply()` (or `getTokenSupply` on Solana), samples wallet balances, proves same-looking transfer groups from receipts, and compares the four-chain total with Bridge's. Each part is `pass`, `fail` or `unchecked`, and the run ends with one line: `RESULT: FULL PASS`, `RESULT: FAIL` or `RESULT: UNCHECKED`. The exit code says which:

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Full pass: all four chains and Bridge passed | The only code that allows publishing |
| 1 | A proven mismatch, or a crash | Stop and investigate. Don't rerun until it is understood |
| 2 | Usage or configuration, such as a missing key, a database held by another process, or a schema that doesn't match the code | Fix the setup and rerun |
| 3 | Nothing is proven wrong, but something wasn't checked | Read the reasons. Usually rerun later, or run `make sync` first |

Bridge's comparison counts: a Bridge error or mismatch stops exit 0. It uses Bridge's own `last_updated` time, taking each chain's supply at some block from 5 minutes before to 1 minute after it, with no tolerance in the amount. Any `--chain` or `--at-block` run is a partial check, so it exits 3 even when it prints `MATCH`. `make` turns any failed recipe into exit 2, so use `uv run --locked --env-file .env ousd reconcile` when the code matters. On Solana the check reads every wallet's balance, and a check that could not run prints `UNCHECKED`.

The seven blocking checks that sit between the models and publishing are listed in [the architecture](architecture.md#blocking-checks).

## The daily run

`make run` runs the Dagster job `ousd_daily` in one process: `raw_transfers`, `chain_reconciliations`, `dbt_marts`, then `published_dataset`. It needs `BASE_RPC_URL` and `SOLANA_RPC_URL`, like `make sync`. A failed check, a reconciliation that isn't a full pass, or a failed dbt build stops the run before publish, marks the last published dataset stale, and publishes nothing. Ingest and reconciliation retry twice, five minutes apart, when a source errors. A failed check or reconciliation never retries. Dagster's own state is kept in `data/.dagster`.

The Dagster schedule (06:00 UTC every day) and failure sensor ship off. They run only while the UI that `make dagster-dev` serves is up and someone has switched them on. The hosted daily run does not use them: it is a Railway cron job running `scripts/daily.sh`, which calls `make run`, then builds the release and deploys a preview. See [deploying the daily run](deploy.md).

Don't run `make run` while another sync or `ousd` command holds the database.

### Limits on a run

A run-scoped resource caps how long a run may take, so a hang can't go unnoticed:

| Variable | Limit | Default |
|---|---|---|
| `OUSD_MAX_RUNTIME_SECONDS` | The whole pipeline run | 10800 |
| `OUSD_DBT_TIMEOUT_SECONDS` | The dbt build | 1800 |
| `OUSD_RATE_LIMIT_WAIT_SECONDS` | Total time spent waiting out servers' rate limits | 3600 |

## Alerts and heartbeat

A failed run writes `data/alerts/<run_id>.json` from a failure hook inside the run, so `make run` alerts too. A failure outside the pipeline on the hosted run, such as a refused release, a failed deploy or a bad setting, writes `data/alerts/daily-<time>.json` through `ousd alert`.

With `OUSD_ALERT_WEBHOOK_URL` set, each alert is also posted there as JSON: `text`, `run_id`, `job`, `step`, a scrubbed `reason` and `failed_at`.

With `OUSD_HEARTBEAT_URL` set, `ousd heartbeat` pings that URL only after a whole run has succeeded: published, released and deployed, or built with the deploy off. A plain `make run` with the URL set pings once the run publishes, from the `heartbeat_on_publish` hook in `pipeline/dagster/definitions.py`. The hosted run (`scripts/daily.sh`) blanks the URL for its `make run`, so the pipeline never pings early, and pings itself after the deploy. A dead-man check on that URL notices a run that failed before it could alert, or never started.

Both URLs are secrets, like the RPC URLs. They are read from the environment, never put on a command line or in a log, and scrubbed from any error. With neither set, nothing is sent anywhere.

## Backup and restore

`data/ousd.duckdb` is the only copy of the raw store that matters. The marts rebuild from it in seconds, but the raw store takes hours to rebuild from the chains, and Solana history needs a keyed provider. Backups are manual only: `scripts/daily.sh` doesn't call `make backup`, so no backup failure can fail a daily run, and the hosted volume has no backups enabled.

### Backup

`make backup` (or `ousd backup`) takes the writer lock, runs `CHECKPOINT` so the file holds every change, copies it to `OUSD_BACKUP_DIR` (default `data/backups`) as `ousd-YYYYMMDDTHHMMSSZ.duckdb` (UTC), and releases the lock. DuckDB's lock is a POSIX record lock, which a process loses when it closes any descriptor on the file, so the copy reads through one descriptor opened before the lock is taken and closed after it is released. It then hashes the copy, opens it read-only to prove DuckDB can read it, and writes `<name>.sha256` in the format `sha256sum -c` reads. The checksum is written last, so a copy without one is incomplete. Like the other writers, it exits 2 with "database in use" while another process holds the file, and copies nothing. It applies no migrations: a copy keeps the schema it was taken at. Each copy is the size of the database, about 90 MB as of November 2026.

### Upload

With `OUSD_BACKUP_URL=s3://bucket/prefix`, `OUSD_BACKUP_ACCESS_KEY_ID` and `OUSD_BACKUP_SECRET_ACCESS_KEY` set, the copy goes to S3-compatible object storage through boto3, then its size is checked, then the checksum is uploaded. For an endpoint other than AWS, also set `OUSD_BACKUP_ENDPOINT_URL` and `OUSD_BACKUP_REGION`. The endpoint must use https. Plain http is accepted only for `localhost` or `127.0.0.1`, such as a local test server.

The credentials are passed to boto3 explicitly, and configured endpoints are ignored, so neither the credentials nor the endpoint ever come from `~/.aws` or `AWS_*` variables. Only the region does, when `OUSD_BACKUP_REGION` is unset. A failed upload exits 1 and keeps the local copy. Exit 0 means the copy is on disk and, when a URL is set, in the bucket. The output names objects only, never the bucket, prefix, URL or endpoint. The upload is checked by size, not by reading it back, so the `.sha256` in the bucket is what proves a downloaded copy intact. The backup credentials are secrets the same way the RPC URLs are, and a failed object storage call reports only its step and the provider's error code.

### Retention

After each backup, in the folder, and after an upload, among the objects directly under the prefix, retention keeps the newest complete copy of each of the last `OUSD_BACKUP_KEEP_DAILY` (default 7) UTC days that have one, and the newest of each of the last `OUSD_BACKUP_KEEP_WEEKLY` (default 4) ISO weeks that have one. The two overlap, so the defaults keep 7 to 10 copies. Days and weeks are counted only when they have a copy, so if backups stop, the old ones never age out to nothing. An incomplete copy, or a hidden `.partial` file a killed run left, is removed once a newer complete copy exists. The copy just taken is always kept, even if the clock stepped back. Files not named like a copy are never touched. Retention reads only names, so use one folder and one prefix per database.

### Restore

1. Stop every writer. On the host, set the start command to `sleep infinity` with no cron schedule, as in the first seeding in [deploying the daily run](deploy.md#first-seeding).
2. Put the copy and its `.sha256` in one folder. From a bucket, use any S3 tool given the bucket's credentials, for example `aws s3 cp s3://<bucket>/<prefix>/ousd-<stamp>.duckdb .`, then the same for `ousd-<stamp>.duckdb.sha256`. When `OUSD_BACKUP_ENDPOINT_URL` is set, add `--endpoint-url "$OUSD_BACKUP_ENDPOINT_URL"` to each command.
3. Run `ousd restore <folder>/ousd-<stamp>.duckdb`, with `OUSD_DB_PATH` pointing at the target. It checks the copy against its checksum, and that DuckDB opens it, before changing anything. It exits 1 on a mismatch, a missing checksum, or a copy at a schema newer than the code. If a database is already there it refuses, unless you pass `--force`. Then it takes the writer lock (exit 2 if another process holds it), swaps the copy in atomically, and keeps the old file as `<target>.replaced-<stamp>`. The lock covers the old file, so no writer has it open while it is kept and swapped out. It doesn't cover the restored file, which is complete before the swap, so a writer may open it straight after. Delete the kept file once the restore is checked. A damaged database can't be locked, so `--force` refuses it: move it aside, then restore without `--force`.
4. A copy older than the code is migrated as usual: the next writer, or `ousd migrate`, applies the pending migrations. `ousd check` and `ousd publish` only read, so until then they exit 2 and say to run `ousd migrate`. `restore` prints when this applies. A copy newer than the code is refused, because nothing could open it until the code is updated.
5. Verify offline with `ousd migrate`, `make models`, then `ousd check --run-id <id>`. Every check reads stored data except freshness, which fails for a copy whose newest transfer or reconciliation is over 36 hours old. The next `make run` catches up from the cursor.

## Schema migrations

The raw store's schema is versioned. Every change is a new migration at the end of `MIGRATIONS` in `pipeline/ousd/migrations.py`, and [the architecture](architecture.md#schema-changes) states the rules for writing one.

`ousd migrate` applies what is pending and needs no key. A writer also applies pending migrations in one transaction when it opens the store, and with nothing pending it writes nothing. Readers run no DDL: with migrations pending they refuse, exit 2, and say to run `ousd migrate` or any writer first. Every open refuses a schema newer than the code, and a database whose recorded migration names differ from the code's. `make publish` stops with exit 2 for the same reason, and `make models` needs the raw database free of a writer.

## The site

The site is static Next.js. It reads a published dataset at build time, and visitors' browsers read nothing else. None of its commands load `.env`, and web code never reads an RPC variable.

**Run pnpm only through `npx`, never bare.** Every site command goes through `npx` at the pnpm version in `web/package.json`'s `packageManager`, because a bare or Corepack `pnpm` can crash with "Cannot find module". Use the `make web-*` targets, which do this for you. If Node or npm is missing or out of range, the targets fail with a message saying what to install. They never skip.

```sh
make web-install   # install the site's packages
make web-samples   # build both bundled samples, which are marked as samples on every page
make web-build     # build from OUSD_DATASET_DIR, else data/published/latest, else the sample
make web-release   # a release build: refuses sample, preview and unchecked data
make web-browser   # download the browser that make web-shots needs
make web-shots     # local screenshots of the samples
```

`make preview` writes a local preview dataset outside `data/published`, for site development. A preview is marked as one and is never a release. `make web-release` needs a real dataset from a run whose checks all passed. If that dataset carries warnings, the release prints each one and refuses until `OUSD_ACK_WARNINGS` is set to the dataset's version, or until every warning's `chain:metric` is listed in `OUSD_ACK_WARNING_KEYS` (comma-separated, for a known warning on an unattended run; the listed keys are logged on every release).

## The hosted daily run

One Railway cron service runs the pipeline at 06:00 UTC deploys a Vercel preview of the verified site, and promotes it to production when every step has passed. The service settings, variables, first seeding and a local test are in [deploying the daily run](deploy.md).

## Hosting hardening

What keeps the hosted run's privileges small. Some items hold on any host, and the rest depend on the host: the current one is Railway, and a VM is the likely next one.

These hold on any host, and the code enforces them:

- **Each step sees only the variables it needs.** `make run` gets no Vercel variable, `make web-release` and `vercel deploy` get an allowlist (see [deploying the daily run](deploy.md#what-runs)), and the dbt build gets its own: `PATH`, `HOME`, `LANG`, `LANGUAGE`, the `LC_*` variables, `TZ`, `TMPDIR`, `TERM`, `NO_COLOR`, `OUSD_DB_PATH`, `OUSD_MARTS_DB_PATH` and dbt's own `DBT_*` settings, except `DBT_ENV_SECRET_*`. So no RPC URL, webhook, heartbeat URL, backup credential or Vercel token reaches dbt. The daily run applies it in `run_dbt_build` (`pipeline/dagster/definitions.py`), and `make models` applies the same list. The labels path is the dbt var `labels_path`, not a variable.
- **New files are the run user's alone.** `scripts/daily.sh` sets `umask 077` before anything else, so everything it creates under `data/`, `web/.build`, `web/.release` and `dbt/target` is `600` (executables and folders `700`, other files `600`). The release is read back only by the same user, to verify and upload it.

The rest depends on the host:

| Item | Railway (current) | VM |
|---|---|---|
| No inbound ports | Public networking stays off, and the run listens on nothing. It is a cron job that starts, runs and exits | Firewall denies all inbound traffic except SSH. Nothing else listens on a public address |
| Dagster UI | Not run. The hosted run is `scripts/daily.sh`, which has no UI | Only over an SSH tunnel to `127.0.0.1`, never public: `make dagster-dev` on the host (the UI binds `127.0.0.1:3000`, Dagster's default; never pass `--host 0.0.0.0`), then `ssh -N -L 3000:127.0.0.1:3000 <user>@<host>` locally and open `http://127.0.0.1:3000` |
| SSH | No SSH server in the image. `railway ssh` goes through the Railway CLI and the account's login, so the account needs two-factor authentication | Keys only: `PasswordAuthentication no`, `KbdInteractiveAuthentication no` and `PermitRootLogin no` in `sshd_config` |
| OS security updates | The host OS is Railway's. The image's Debian packages update when it is rebuilt, so redeploy after a Debian security release, and raise the pinned `node` base image with Node's patch releases | Unattended security updates on: `unattended-upgrades` on Debian or Ubuntu, with a reboot window for kernel fixes |
| Run user | Root, as Railway's volume mounts as root. See [why the image runs as root](deploy.md#why-the-image-runs-as-root) | A dedicated service user with no login shell and no sudo and a writable `HOME` (dbt writes `~/.dbt`), owning only `data/` and the folders the run writes: `web/.build`, `web/.release`, `web/node_modules`, `dbt/target`, `dbt/logs`, and `.venv` when uv has to sync it. The checkout is otherwise owned by another user and read-only to it |
| Secrets | Service variables, sealed: a sealed value reaches the run but can't be read back in the UI, the API, `railway variables` or `railway run`. There is no `.env` | `.env` at mode `600`, owned by the service user (`chmod 600 .env` and `chown <service-user> .env`), and never committed |
| Deploy token | `VERCEL_TOKEN`, scoped to the one Vercel team that owns the project, with an expiry | The same |

**Rotating the Vercel token.** Rotate it before it expires, at least every 90 days, and at once if it may have leaked: create a new token with the same scope, replace `VERCEL_TOKEN` in the host's secrets, run once with the deploy on and check the preview, then delete the old token in Vercel. The RPC keys, webhook and heartbeat URLs and backup credentials rotate the same way: new value in, one good run, old value revoked.
