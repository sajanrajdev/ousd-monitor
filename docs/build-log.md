# Build log

Honest notes on what went wrong and what the data taught us. Newest phase last.

## Phase 1, 2026-11-03: ingestion and reconciliation

### What went wrong

**The first mint on Ethereum was earlier than first assumed.** We expected the first log near block 25180434. The first Transfer returned from that range came from a non-zero address, which means the sender already held tokens. Searching from block 0 found a 5 OUSD mint at block 25153426, and the first log of any kind at 25137271. Starting at the suggested block would have lost that mint, and reconciliation would have been off by a small amount. `start_block` is now 25137271.

**Blockscout's free rate limit is far tighter than expected.** It allowed about 10 pages, then returned 429 with `x-ratelimit-limit: 10` and a reset 22 to 36 minutes away. The first version backed off for about 30 seconds in total and then crashed. The client now reads `Retry-After` and `x-ratelimit-reset`, and pauses before the next request when a success spends the last of a window. The reset header's unit is inferred to be milliseconds from its size, not from documentation. Each rejected request may also push the reset further out, but we did not test that. A cold Ethereum backfill takes hours because of this.

**Tempo's documented 100,000 block limit is not usable at current volume.** Two separate problems appeared as logs got denser:

- Over 20,000 results, the RPC returns an explicit error. It does not truncate, so nothing is lost. The client now splits such ranges.
- Large responses often get a 502 from Cloudflare with `Retry-After: 60`. Measured over 10 requests per span: 100,000 blocks failed 7 times (responses up to 8.9 MB), 50,000 failed 2 times, 20,000 failed 0 times (up to 3 MB). This looked like a rate limit, and at one point `curl` succeeded while the pipeline failed, which sent us chasing HTTP versions, compression and connection reuse. None of those explained it. Size did. The range is now 20,000 blocks. The backfill went from a retry every few ranges to none.

**`executemany` was too slow.** About 0.86 ms per row is fine at 1,000 rows, but not at 20,000 per range, and the database stays locked while it runs. Binding one list per column and using `unnest` wrote 20,000 rows in 0.1 s.

**Commits that failed lint.** One batch of commits was made while `make check` was failing, because the commit script did not depend on its result. It was caught before pushing and the commit was amended.

**A paging test that was wrong.** One test asserted that a full page in a single block returned nothing. That case actually raises an error, as intended. The test was rewritten to cover what its name promised: a page ending exactly on a block boundary.

**One unexplained stall, still unproven.** The very first Ethereum run stopped writing after about 2 minutes and sat idle for about 27 minutes until it was killed. Its output was buffered through `tail`, so there is no log of why, and the cause can't now be established. There are two candidates. One is a slow read, since the 60 second timeout only limits the gap between bytes. The other is a rate limit wait: 27 minutes is inside Blockscout's 22 to 36 minute reset, and the earliest committed client could already wait up to 30 minutes on a 429. Its warning would have sat in the same buffer. Both are now closed off. Each attempt has a 120 second deadline, tested against a real trickling socket, and every pause of 5 seconds or more logs its length. A silent gap now means a real hang. Don't pipe a long run through `tail`.

**A review of this code found bugs the tests had missed.** Each now has a test.

- **A reorg between two log ranges broke repair.** Repair assumes a stored hash commits to its ancestors, but hashes were stored one at a time with no link between them. When a fork landed between two ranges, the newest hash still matched, so repair saw nothing wrong. On the old code, if the new fork had a transfer in that block, every later sync failed with "changed during sync; rerun", forever. If it had none, a transfer that no longer existed stayed stored with no error. A new block must now extend the stored block below it.
- **Healing missed logs depended on timing.** The re-read only covered blocks near the current tip. Tempo's window is 16 blocks, so a log missed by a lagging node was lost for good unless the next run started within seconds. If it wasn't a mint or burn, reconciliation would never notice. Each run now re-reads the newest blocks below the cursor.
- **A short Blockscout page ended the range.** If the server's limit were ever below 1,000, everything after the first page would have been skipped and marked complete. A range now ends only on a response with nothing past its first block, at the cost of one extra request. Pages out of order or out of range now raise an error.
- **Blockscout could serve unfinalized blocks.** With finality stalled deeper than the 2,000 block tail, rows with no hash could land above finality. History now stops at finality.
- **A conflicting row was silently dropped.** `ON CONFLICT DO NOTHING` also hid a different row at the same position. It now raises. This adds about 15 ms per 20,000 rows at 2M stored rows.
- **Smaller ones.** A Bridge total given as a JSON number or with too many decimals was silently truncated, and now raises. Nothing checked `chain_id`, so a mispasted RPC URL looked like a quiet chain. Logs from another contract weren't rejected locally. Provider URLs reached logs, errors and `repr(Chain)`. A rate limit hint outlived its response and could repeat a long wait after an unrelated failure. A node lagging behind every stored block got advice to rebuild the database, which costs hours. `--chain tempo` listed Ethereum as neither checked nor missing. A sync after a long backfill finished hours behind the tip, too old for reconciliation on public nodes.

**More commits that failed the check.** Three commits in this review went in with one test failing, because the command was `make check | tail && git commit`, and a pipeline's exit status is `tail`'s. This is the same mistake as the earlier lint failure. The test had pinned the old request sequence, and a follow-up commit updated it. Run the check without a pipe when a commit depends on it.

**Decisions from the review.**

- The key stays chain, block and log index, though `docs/architecture.md` says chain, transaction and log index. They identify the same rows on one EVM chain, and changing it means rebuilding a table in a live database for no gain on these two chains. Revisit with Solana.
- `make reconcile` can still exit 0 with chains unchecked, and the README says so. Deciding what counts as a full pass belongs to the cross-chain reconciliation unit, and nothing publishes before that.

**Known gaps.** A Blockscout index that lags more than the 2,000 block tail would return "No logs found" for blocks that have logs, and the cursor would pass them. Reconciliation catches this for mints and burns, not ordinary transfers, so the sampled balance check must stay blocking. Whether Blockscout and RPC report the same `logIndex` for a block hasn't been checked. If they differ, a re-read across the boundary would store duplicates at new positions.

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

## Phase 1, 2026-11-04: the first full reconciliation

### Result

The first full pass ran at 2026-11-04 09:24 UTC. Run scope `full`, exit 0, and the publish gate reads it as usable. Every difference below is 0 base units.

| Chain | Block or slot | Minted | Burned | Net, equal to supply | Transfers | Balance check |
|---|---|---|---|---|---|---|
| Tempo | 47370805 | 745,972,873.52 | 126,307,115.77 | 619,665,757.75 | 370,446 | Census of 2,004 wallets, 0 mismatches |
| Ethereum | 26340519 | 209,850,230.89 | 97,679,283.70 | 112,170,947.19 | 37,240 | 423 balance reads including its census, 0 mismatches |
| Base | 53497416 | 112,317,166.82 | 21,290,034.06 | 91,027,132.76 | 71,130 | 50 sampled wallets, 0 mismatches |
| Solana | 465246653 | 120,140,472.34 | 40,463,624.86336 | 79,676,847.47664 | 64,945 | Every wallet read, 8,871, 0 mismatches |

"Net, equal to supply" is mints minus burns, and it matched `totalSupply()` on the EVM chains and `getTokenSupply` on Solana.

**Bridge matched on the first attempt.** Bridge's `last_updated` was 2026-11-04T09:00:38Z, and we fetched it 601 s later. The four chains at that window summed to 902,538,033.87664, Bridge reported 902,538,033.87664, and the difference was 0. The sum of the four chains at their tips was higher, because supply kept moving after Bridge's time. That is why the check takes each chain's supply at Bridge's own time and not at the tip. Comparing tips would have reported a mismatch that wasn't one.

**Same-looking groups are all real.** Tempo's 3,247 transactions with a group were proven from their receipts, and Ethereum's 6 from Blockscout logs. No address has a negative balance on any chain.

**A second full run also passed.** At 2026-11-04 09:25 UTC it exited 0 again, with no census flag. Bridge read 902,540,685.17664, updated 09:20:49Z, which equals the chain sum, a difference of 0.

### Base

The first cold backfill took 16 min 38 s, with no retries and no reorgs logged. It stored 70,743 transfers to block 53490000. Earlier checks matched at the start block, before and at the first mint, and at 52483090. A second cold backfill agreed with the first row for row, with 0 differences either way through block 53488800. It stopped once on a `-32603` "internal filter error" at block 52.53M, and that error is now retried.

### Solana

Two runs, about 175 minutes in total, with 2,802 HTTP 429 retries. No part of a key appeared in any log.

**The first run stopped at the invariant on a plain burn.** At slot 459717019 it met a burn that was not a `Checked` form. All 142 mints and burns in our sample were `Checked` forms, so the decoder assumed they all were. The stop stored no wrong number. A small decoder change resumed the run from its cursor.

**Credits charged are unknown.** The RPC doesn't report them, and the provider's dashboard wasn't read.

### What reviews found before the real run

These were found before any real run, by reviews that reproduced each one against fakes. Each has a test now.

- **Keys leaked through parse errors.** A provider key could reach a log or an error through a parse error.
- **The publish gate trusted the run row alone.** A pass could still be read as current after newer rows landed, or after rows changed at the same height. The gate now also compares each chain's cursor, pin hash and transfer count with what the run recorded.
- **A stale Solana balance read could hide a mismatch.** A balance read at an older slot than the comparison could leave later movements unchecked and still report a match. A read now has to sit within about a minute of the cursor.
- **A probe could answer for the wrong chain.** A reader for one chain could answer a question about another.
- **A comparison row was written before its check row.** The order was wrong, so the check row now comes first.

### Known limits

- **A lost transfer can pass.** A transfer lost between two wallets with no later rows passes until one of them is drawn into a sample. On Tempo that is about 3% a run.
- **A Bridge error can pass.** An error exactly equal to the moves inside the window matches one of the attainable sums.
- **Scrubbing has gaps.** A key under 8 characters, a key joined by `-` or `_`, and a key that is fully percent-encoded all survive scrubbing.
- **Solana has no reorg test.** It reads finalized data only, so there is nothing to simulate.
- **`solana.py`'s checks are protected by hand.** Path enforcement for that file is an owner change, so for now a reviewer has to watch it.

### Decision closed

**The key stays chain, block or slot, and log index.** This closes the earlier "Revisit with Solana". Solana's `log_index` is built from the transaction index and the position within the transaction, so it fits the same key, and no table needed rebuilding.
