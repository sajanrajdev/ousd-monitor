.PHONY: check lint test build sync reconcile

# Load .env when it exists, so a keyed provider can replace the public defaults.
ENV_FILE := $(if $(wildcard .env),--env-file .env)

check: lint test

lint:
	uv run --locked ruff check .
	uv run --locked ruff format --check .

test:
	uv run --locked pytest

build:
	uv build --wheel

sync:
	uv run --locked $(ENV_FILE) ousd sync

reconcile:
	uv run --locked $(ENV_FILE) ousd reconcile
