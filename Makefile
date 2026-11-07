.PHONY: check lint types test build models dbt-docs sync reconcile publish preview run daily \
	dagster-dev backup py-lint py-types py-test py-build \
	web-tools web-install web-lint web-types web-test web-samples web-build web-release web-browser \
	web-shots web-acceptance demo demo-build

# Load .env when it exists, so a keyed provider can replace the public defaults.
ENV_FILE := $(if $(wildcard .env),--env-file .env)

# The site's steps join these targets only once web/package.json exists. After that they never
# skip: without the right Node they fail, because a check that passes silently is worse.
HAS_WEB := $(wildcard web/package.json)

check: py-lint py-types py-test $(if $(HAS_WEB),web-lint web-types web-test web-samples)

lint: py-lint $(if $(HAS_WEB),web-lint)

types: py-types $(if $(HAS_WEB),web-types)

test: py-test $(if $(HAS_WEB),web-test)

build: py-build $(if $(HAS_WEB),web-build)

py-lint:
	uv run --locked ruff check .
	uv run --locked ruff format --check .
	uv run --locked sqlfluff lint dbt/models dbt/tests --dialect duckdb --templater jinja

py-types:
	uv run --locked mypy

py-test:
	uv run --locked pytest

py-build:
	uv build --wheel

# dbt sees only these variables, as in the daily run (DBT_ENV_NAMES in pipeline/dagster/
# definitions.py): no RPC URL, webhook, backup credential or deploy token. Names are picked from
# make's environment or command line; the values are read by the shell inside uv run, so dbt gets uv's PATH.
DBT_ENV_NAMES := PATH HOME LANG LANGUAGE TZ TMPDIR TERM NO_COLOR OUSD_DB_PATH OUSD_MARTS_DB_PATH
DBT_ENV = $(strip $(foreach name,$(sort $(DBT_ENV_NAMES) \
	$(filter-out DBT_ENV_SECRET_%,$(filter DBT_% LC_%,$(.VARIABLES)))),\
	$(if $(filter environment% command%,$(origin $(name))),$(name)="$$$(name)")))

models:
	uv run --locked sh -c 'exec env -i $(DBT_ENV) dbt build --project-dir dbt --profiles-dir dbt'

# One self-contained HTML page of the models, sources, exposures and lineage, at
# dbt/target/docs/static_index.html (dbt/target/ is ignored). --target-path is relative to the dbt
# project directory, so `target/docs` lands there. It has its own target path because
# docs generate overwrites run_results.json, which the dbt check reads from dbt/target. It reads
# column types from the marts database, so run `make models` first.
dbt-docs:
	uv run --locked dbt docs generate --static --project-dir dbt --profiles-dir dbt \
		--target-path target/docs

sync:
	uv run --locked $(ENV_FILE) ousd sync

reconcile:
	uv run --locked $(ENV_FILE) ousd reconcile

# Publish runs after a failed check too: it refuses by itself, and marks the last good dataset
# stale. Only exit 2 stops here, as it says nothing about the data: another process holds the
# database (readers share it only with readers), or its schema doesn't match the code, as when
# migrations are pending: run `ousd migrate`.
# .env is for the database path, as neither step uses a key.
publish:
	run_id=$${RUN_ID:-$$(date -u +%Y%m%dT%H%M%SZ)}; \
	uv run --locked $(ENV_FILE) ousd check --run-id "$$run_id"; \
	[ $$? -eq 2 ] && exit 2; \
	uv run --locked $(ENV_FILE) ousd publish --run-id "$$run_id"

# Local preview for site development, never a release. It writes outside data/published.
preview:
	run_id=$${RUN_ID:-preview-$$(date -u +%Y%m%dT%H%M%SZ)}; \
	uv run --locked $(ENV_FILE) ousd check --run-id "$$run_id" --allow-partial; \
	uv run --locked $(ENV_FILE) ousd publish --run-id "$$run_id" --allow-partial

# A checksummed copy of the raw database in data/backups, uploaded when OUSD_BACKUP_URL is set.
# For manual use: the daily run doesn't call it. Exit 2 means another process holds the database.
backup:
	uv run --locked $(ENV_FILE) ousd backup

# Dagster needs an absolute home. The folder is created first, and data/ is gitignored. Load the
# module as a file: the pipeline/dagster folder has no __init__.py, so it can't shadow dagster.
DAGSTER_HOME := $(CURDIR)/data/.dagster
DAGSTER_FILE := pipeline/dagster/definitions.py

# The whole run, from ingest to data/published/latest, in one process. It needs the keys in .env.
run:
	mkdir -p "$(DAGSTER_HOME)"
	DAGSTER_HOME="$(DAGSTER_HOME)" uv run --locked $(ENV_FILE) dagster job execute -f $(DAGSTER_FILE) -j ousd_daily

# The hosted daily run: make run, then the release, then a Vercel preview. See docs/deploy.md.
# OUSD_DEPLOY=0, or no VERCEL_TOKEN, builds and verifies the release without deploying.
daily:
	scripts/daily.sh

# The UI, and the schedule and failure sensor once they are switched on there.
dagster-dev:
	mkdir -p "$(DAGSTER_HOME)"
	DAGSTER_HOME="$(DAGSTER_HOME)" uv run --locked $(ENV_FILE) dagster dev -f $(DAGSTER_FILE)

# Always through npx, never a bare pnpm: see docs/operations.md. The version's one home is
# packageManager in web/package.json. These steps never load .env.
PNPM_SPEC = $(shell sed -n 's/.*"packageManager": *"\([^"]*\)".*/\1/p' web/package.json 2>/dev/null)
PNPM = npx --yes $(PNPM_SPEC) --dir web
NODE_RANGE = $(shell sed -n 's/.*"node": *"\([^"]*\)".*/\1/p' web/package.json 2>/dev/null)

web-tools:
	@test -f web/package.json || { echo "No site here: web/package.json is missing."; exit 1; }
	@test -n "$(PNPM_SPEC)" || { echo "web/package.json has no packageManager, so there's no pnpm version to run."; exit 1; }
	@command -v node >/dev/null 2>&1 || { echo "Node is missing. Install Node $(NODE_RANGE), which includes npm and npx."; exit 1; }
	@command -v npx >/dev/null 2>&1 || { echo "npx is missing. Install npm, or reinstall Node $(NODE_RANGE), which includes it."; exit 1; }
	@node web/scripts/check-node.mjs

web-install: web-tools
	$(PNPM) install --frozen-lockfile

web-lint: web-install
	$(PNPM) run format:check
	$(PNPM) run lint

web-types: web-install
	$(PNPM) run types

web-test: web-install
	$(PNPM) run test

# Both samples, as CI has no data/. Each is built and verified under web/.build/.
web-samples: web-install
	OUSD_DATASET_DIR=fixtures/dataset/complete $(PNPM) run build complete
	OUSD_DATASET_DIR=fixtures/dataset/partial $(PNPM) run build partial

# From OUSD_DATASET_DIR, or else data/published/latest, or else the sample, and the page says which.
web-build: web-install
	$(PNPM) run build

# Refuses anything that isn't release grade. web/.release/latest moves only after a verified build.
web-release: web-install
	$(PNPM) run release

# An explicit download, and the only one a local screenshot run needs beyond the packages.
web-browser: web-install
	$(PNPM) exec playwright install chromium

# Local only. Never called by check.
web-shots: web-samples
	$(PNPM) run shots

# Local only. Never called by check. Needs the browser from web-browser.
web-acceptance: web-samples
	$(PNPM) run acceptance

# The complete sample, built and served on localhost. It needs no keys, no .env and no chain
# access, and the page says it is a sample. DEMO_PORT picks the port; stop it with Ctrl-C.
DEMO_PORT ?= 8000

demo-build: web-install
	OUSD_DATASET_DIR=fixtures/dataset/complete $(PNPM) run build complete

demo: demo-build
	@echo "Serving the sample site at http://127.0.0.1:$(DEMO_PORT)/ (Ctrl-C to stop)"
	uv run --locked python -m http.server --directory web/.build/complete --bind 127.0.0.1 $(DEMO_PORT)
