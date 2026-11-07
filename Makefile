.PHONY: check lint types test build models sync reconcile publish preview run daily dagster-dev \
	py-lint py-types py-test py-build \
	web-tools web-install web-lint web-types web-test web-samples web-build web-release web-browser \
	web-shots web-acceptance

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

models:
	uv run --locked dbt build --project-dir dbt --profiles-dir dbt

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

# Through npx, because a bare or Corepack pnpm can crash. The version's one home is packageManager
# in web/package.json. These steps never load .env, and web code never reads an RPC variable.
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
