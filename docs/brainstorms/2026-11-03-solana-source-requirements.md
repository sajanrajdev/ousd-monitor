---
date: 2026-11-03
topic: solana-source
---

# Solana source (Phase 1, unit 1.3)

Settled from `docs/PRD.md`, `docs/architecture.md`, the code on `dev` and read-only probes on 2026-11-03. Evidence and the approach are in `docs/plans/2026-11-03-004-solana-source-plan.md`.

## Problem

Solana holds about 80M of Open USD's supply, and Phase 1 isn't done until all four chains reconcile to the base unit. Solana has no logs, and its supply call can't be read at a past slot, so the EVM approach doesn't carry over. The check has to mean the same thing anyway.

## What the probes changed

- **OUSD is Token-2022, and all 8,310 current token accounts carry extensions that make the mint mandatory on a transfer.** So history keyed on the mint covers transfers as well as supply.
- **Every sampled mint and burn was an inner instruction.** A top-level-only parser would see no supply at all.
- **A second mint moves 1:1 with OUSD in the same mint and burn instructions.** Only a filter on the mint address keeps it out. We don't know what it is, so we don't name it.
- **The mint dates from 2026-04-21, and the earliest sampled mint of OUSD from 2026-04-24.** That's five months before day 0.
- **Version 1 transactions exist.** A client asking for version 0 gets an error for them, not a result.
- **Two transactions in one slot can use the same instruction position.** Instruction position alone can't be the row's position in the block.
- **One call returns every token account at one slot.** Balances can be checked for every wallet, not a sample, and they summed to exactly the supply.
- **About 1 in 8 sampled transactions routes through a token account created and closed inside it.** That account has no token balance entry, so its owner must come from its initialize instruction.

## Requirements

**What gets captured**

- S1. Ingest every successful public OUSD balance movement on Solana from the mint's creation onward: mints, burns and transfers, at any instruction depth.
- S2. Filter by the mint address. Rows from any other mint never enter the store, including one in the same instruction group.
- S3. Exclude failed transactions, including inner instructions that ran before the failure.
- S4. Count each movement exactly once. Prove it per transaction: decoded movements must equal the change in that transaction's token balances for this mint. If they don't, stop.
- S5. Say what the source doesn't capture (S14), and never quietly understate activity.

**Same store, same meaning**

- S6. Rows go into the existing `transfers` table with the contract in the Phase 2 plan: mints from and burns to `ZERO_ADDRESS`, `tx_hash` set to the signature, and `log_index` unique within the slot and ordered within the transaction.
- S7. `from_address` and `to_address` are owner wallets. Base58 values keep their case.
- S8. Re-running any range changes nothing.

**Reconciliation**

- S9. The blocking check compares events through slot S with the supply read at slot S, to the base unit, where S is the slot the `finalized` supply reading itself reports.
- S10. If the slot can't be pinned or the tail can't be read through it, the chain is reported as unchecked. It never passes by default.
- S11. Balance reads follow the same rule: read first, sync through the slot the read reports, then compare. A supply match alone doesn't count as reconciled, because it says nothing about transfers.

**Finality**

- S12. Read only at `finalized`. There is no reorg walker, because finalized slots aren't rolled back. Rows have no block hash, and `blocks` holds no Solana rows.

**History, cost and configuration**

- S13. Prove the walk reached the mint's creation, so a provider with truncated history fails loudly before anything is written.
- S14. Record these limits for later metrics (units 2.1 and 2.5):
  - Confidential transfer amounts are encrypted, so they can't be counted. None appear in the sample. Any public or confidential movement through a confidential instruction on this mint stops the sync until someone decides what to do.
  - Instruction legs aren't payments: a route through a temporary account appears as several transfers of the same amount.
  - A token account's owner can change without a transaction naming the mint. Rows keep the owner at the time of the movement, so the balance check has to stay blocking. 8,308 of 8,310 current accounts can't change owner.
- S15. A cold backfill must resume after a crash and run on the existing key without spending money.
- S16. An empty or blank `SOLANA_RPC_URL` means the same as an unset one, because a `.env` copied from `.env.example` sets it to an empty string.

## Success criteria

- `ousd --chain solana reconcile` prints a match with a difference of 0 base units, for supply at a pinned slot and for every wallet, on a real backfill with the keyed URL.
- Re-running a range leaves the row count and values unchanged.
- Every edge case above has a test using real captured JSON, with no network.

## Scope boundaries

- No wallet history beyond the mint's signatures, and no history crawl per token account.
- No interpretation of programs (swap, route or venue). That's Phase 2.
- No concurrency or batching in the fetcher.
- No reorg repair beyond the store's existing manual rollback.

## Key decisions

- **Mint-keyed history is the source for transfers too.** Token-2022 rejects a plain `Transfer` from these accounts, and a 12-account test found no movement outside it. The balance check reports any exception.
- **Decode `jsonParsed`, and enforce S4 per transaction.** This is simpler than decoding instruction bytes, and the invariant catches a wrong decode of any transaction fetched. It can't see a transaction that was never fetched, which is the balance check's job.
- **Owner wallets in the row.** Sampled balances read by owner, so no side table is needed. If token-account identity is needed later, it means refetching.
- **Reconcile pins, then syncs through the pin, then compares.** There's no past-slot read, so this is the only honest order.

## Dependencies and assumptions

- `dev` already has `Store`, `Transfer`, `PoliteClient`, `ChainReconciliation` and `SOLANA_RPC_URL` in `.env.example`. Nothing here assumes a `kind` column, `runners.py`, `reconcile_at` or `PENDING_CHAINS`, because none of them exist.
- `SOLANA_RPC_URL` comes from the maintainer and is set in the primary checkout.
- **Unverified until the real run:** that the whole history reconciles, because nothing has fetched all of it.

## Outstanding questions

None block planning. The plan settles fixtures, the row key, the cost estimate and the interfaces with units 1.2 and 1.4.
