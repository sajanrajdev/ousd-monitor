# Open USD Monitor: agent guide

An independent public dashboard that asks whether Open USD (OUSD) supply is turning into money that moves.

Status: first public version. See `docs/implementation-plan.md`.

## Read first
1. `docs/PRD.md`: why this exists, requirements and integrity rules.
2. `docs/architecture.md`: the binding stack and structure.
3. `docs/implementation-plan.md`: phases and acceptance criteria.
4. `docs/design-system.md`: the binding visual system.

## Project rules
- **Project content only.** Files, commits and PRs contain only information about this project, never personal details about anyone involved.
- **Accuracy beats scope.** Never publish a number that hasn't passed the reconciliation checks in the PRD.
- **Public sources only.** Every entity label records its source and confidence. Never name a partner or person by inference.
- **Filter by contract address.** The OUSD ticker also belongs to Origin Dollar.
- **Stay independent.** No Open Standard logo, wordmark or artwork, and the "not affiliated" line stays visible.
- **No outbound actions without maintainer approval:** no posting, contacting anyone, or making anything public.
- **Secrets stay in `.env`,** which is never committed.
- **If a decision is missing,** make the most reversible one and record it in the relevant doc in the same change.
