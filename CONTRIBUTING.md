# Contributing

Open USD Monitor is an independent public dashboard. Start with [docs/architecture.md](docs/architecture.md) for how it is built and [docs/methodology.md](docs/methodology.md) for what every number means. This page does not repeat either.

## Run it without keys

```sh
make check
```

`make check` runs the Python lint, types and tests, then the site's lint, types, tests and the build of both sample datasets. It needs [uv](https://docs.astral.sh/uv/) and the Node version in `.nvmrc`, and no keys or chain access. `make check` is the source of truth for whether a change is ready. The site renders from a bundled sample dataset when there is no published one.

## Keyed access for Base and Solana

Ethereum and Tempo ingestion work on public endpoints. Base and Solana have no public default, so set your own provider's URLs in `.env` (copy `.env.example`):

- `BASE_RPC_URL`
- `SOLANA_RPC_URL`

`.env` is never committed. Do not paste keys into issues, pull requests or logs.

## DuckDB has one writer

`make sync` and `reconcile` write `data/ousd.duckdb`. `make models` writes `data/marts.duckdb` and attaches `data/ousd.duckdb` read-only. `publish` and `run` chain these steps. DuckDB allows one writer per file, and a read-only attach still needs the file free of a writer, so run the steps one at a time. The second to start exits with code 2 and "database in use".

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) with an area scope: `pipeline`, `dbt`, `web`, `docs` or `ops`, for example `fix(dbt): count mints once`.
- Every pull request has a `## Decisions` section: one line per choice, in the form question -> choice (alternatives considered; cost to change later). The template has it.
- Filter by contract address, never by the OUSD ticker, which Origin Dollar also uses.
- Entity labels need a public source and a confidence. Do not name a partner or person by inference.

## Optional pre-commit hooks

```sh
uv tool install pre-commit   # or: pipx install pre-commit
pre-commit install
```

The hooks run ruff, sqlfluff and Prettier on the files you commit. They are a convenience. They do not replace `make check`.

## Licences

Code is MIT (see `LICENSE`). The published JSON and CSV are CC-BY-4.0.
