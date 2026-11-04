# Build log

Honest notes on what went wrong and what the data taught us. Newest phase last.

## Phase 1, 2026-11-03: ingestion and reconciliation

### What went wrong

**The first mint on Ethereum was earlier than the brief said.** We were told the first log was near block 25180434. The first Transfer returned from that range came from a non-zero address, which means the sender already held tokens. Searching from block 0 found a 5 OUSD mint at block 25153426, and the first log of any kind at 25137271. Starting at the suggested block would have lost that mint, and reconciliation would have been off by a small amount. `start_block` is now 25137271.

**Blockscout's free rate limit is far tighter than expected.** It allowed about 10 pages, then returned 429 with `x-ratelimit-limit: 10` and a reset 22 to 36 minutes away. The first version backed off for about 30 seconds in total and then crashed. The client now reads `Retry-After` and `x-ratelimit-reset`, and pauses before the next request when a success spends the last of a window. The reset header's unit is inferred to be milliseconds from its size, not from documentation. Each rejected request may also push the reset further out, but we did not test that. A cold Ethereum backfill takes hours because of this.

**Tempo's documented 100,000 block limit is not usable at current volume.** Two separate problems appeared as logs got denser:

- Over 20,000 results, the RPC returns an explicit error. It does not truncate, so nothing is lost. The client now splits such ranges.
- Large responses often get a 502 from Cloudflare with `Retry-After: 60`. Measured over 10 requests per span: 100,000 blocks failed 7 times (responses up to 8.9 MB), 50,000 failed 2 times, 20,000 failed 0 times (up to 3 MB). This looked like a rate limit, and at one point `curl` succeeded while the pipeline failed, which sent us chasing HTTP versions, compression and connection reuse. None of those explained it. Size did. The range is now 20,000 blocks. The backfill went from a retry every few ranges to none.

**`executemany` was too slow.** About 0.86 ms per row is fine at 1,000 rows, but not at 20,000 per range, and the database stays locked while it runs. Binding one list per column and using `unnest` wrote 20,000 rows in 0.1 s.

**Commits that failed lint.** One batch of commits was made while `make check` was failing, because the commit script did not depend on its result. It was caught before pushing and the commit was amended.

**A paging test that was wrong.** One test asserted that a full page in a single block returned nothing. That case actually raises an error, as intended. The test was rewritten to cover what its name promised: a page ending exactly on a block boundary.

**One unexplained stall.** The very first Ethereum run stopped writing after about 2 minutes and sat idle for about 27 minutes until it was killed. Its output was buffered through `tail`, so there is no log of why. It may have been a slow read that never reached the per-read timeout. It has not recurred. There is no overall deadline per request, so it could happen again.

### What we learned

**Tempo mints and burns are standard Transfers.** TIP-20 mints appear as `Transfer` from the zero address and burns as `Transfer` to it. Tempo reconciled to the base unit at the tip and at 10 historical blocks, including the block just before the first mint, where supply is exactly 0. TIP-20 also emits separate `Burn` and `TransferWithMemo` events, confirmed by hashing their signatures. We don't count them, or they would double count.

**Tempo fee payments are identifiable, with care.**

- The fee is a `Transfer` to the fee manager, `0xfeec000000000000000000000000000000000000`.
- It comes from the transaction's `feePayer`, which can differ from its sender. In the transaction we inspected, a sponsor paid for someone else.
- In that transaction the amount fits `gasUsed * gasPrice / 10^12`, rounded up: 70,270 gas at 600,000,000 gives 42.162, and the log shows 43 base units. That is one transaction, so treat it as a lead and not a rule.
- It was the last log in its transaction for 160,814 of 160,819 rows. Five transactions have a second transfer to the address.
- The largest transfer to the address is 50 OUSD, far above the median of 48 base units. So `to_address = 0xfeec...` alone may catch ordinary transfers. The stricter rule to test later is: last log in the transaction, sender equals the receipt's `feePayer`, amount equals the computed fee.
- These rows are 43.8% of all Tempo transfers and appear in 78.7% of its transactions, yet total only 138.25 OUSD. This backs up the PRD's warning that headline activity overstates use. Excluding them is later work.

**`start_block` is not the first mint on Tempo.** `totalSupply()` reverts as uninitialized before block 15844819 and returns 0 from there. The first Transfer is a 3 OUSD mint at block 17042261.

**Public node limits on Ethereum.** PublicNode served `eth_call` state at 64 blocks back but refused at 128, and logs at 10,000 blocks back but refused at 50,000. So reconciliation has to run right after a sync. Blockscout logs have no block hash, which is why it only serves blocks more than 2,000 behind the tip.

**Bridge's figure moves quickly.** It read 872,221,164.60664 at the start of the day and 889,381,963.45664 hours later. Any full check needs a stated timing tolerance, as the PRD says.
