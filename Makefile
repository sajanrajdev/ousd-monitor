.PHONY: check lint types test build models sync reconcile publish preview \
	py-lint py-types py-test py-build \
	web-tools web-install web-lint web-types web-test web-build web-browser web-shots

# Load .env when it exists, so a keyed provider can replace the public defaults.
ENV_FILE := $(if $(wildcard .env),--env-file .env)

# The site's steps join these targets only once web/package.json exists. After that they never
# skip: without the right Node they fail, because a check that passes silently is worse.
HAS_WEB := $(wildcard web/package.json)

check: py-lint py-types py-test $(if $(HAS_WEB),web-lint web-types web-test web-build)

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
# stale. Only a database in use (exit 2) stops here, as that says nothing about the data. .env is
# for the database path, as neither step uses a key.
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

web-build: web-install
	$(PNPM) run build

# An explicit download, and the only one a local screenshot run needs beyond the packages.
web-browser: web-install
	$(PNPM) exec playwright install chromium

# Local only. Never called by check.
web-shots: web-build
	$(PNPM) run shots
