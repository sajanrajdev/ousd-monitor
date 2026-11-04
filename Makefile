.PHONY: check lint types test build models sync reconcile

# Load .env when it exists, so a keyed provider can replace the public defaults.
ENV_FILE := $(if $(wildcard .env),--env-file .env)

check: lint types test

lint:
	uv run --locked ruff check .
	uv run --locked ruff format --check .
	uv run --locked sqlfluff lint dbt/models dbt/tests --dialect duckdb --templater jinja

types:
	uv run --locked mypy

test:
	uv run --locked pytest

build:
	uv build --wheel

models:
	uv run --locked dbt build --project-dir dbt --profiles-dir dbt

sync:
	uv run --locked $(ENV_FILE) ousd sync

reconcile:
	uv run --locked $(ENV_FILE) ousd reconcile
