# Open USD Monitor: contributor guide for coding agents

An independent public dashboard that asks whether Open USD (OUSD) supply is turning into money that moves.

Start with [the PRD](docs/PRD.md) for why this exists, [the architecture](docs/architecture.md) for the stack and structure, and [the design system](docs/design-system.md) for the visual system. [Operations](docs/operations.md) says how to run it, and [the roadmap](docs/roadmap.md) says what is next.

## Rules

- **Accuracy beats scope.** Never publish a number that hasn't passed the reconciliation checks.
- **Public sources only.** Every entity label records its source and confidence. Never name a partner or person by inference.
- **Filter by contract address.** The OUSD ticker also belongs to Origin Dollar.
- **Stay independent.** No Open Standard logo, wordmark or artwork, and the "not affiliated" line stays visible.
- **Do nothing outward-facing without approval.** Don't post, contact anyone or make anything public.
- **Secrets stay in `.env`,** which is never committed. Never log or print a key or an RPC URL.
- **Record decisions.** If a decision is missing, make the most reversible one and record it in the relevant doc in the same change.
- **Project content only.** Files, commits and pull requests contain information about this project and nothing else.

`make check` must pass before a change is ready.
