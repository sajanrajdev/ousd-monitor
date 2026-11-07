# Lessons learned

Honest notes on what went wrong and what the data taught us, grouped by area and dated. Newest last. Each fix named here has a test.

## Ingestion and reconciliation, 2026-11-03

### What went wrong

**The first mint on Ethereum was earlier than first assumed.** We expected the first log near block 25180434. The first Transfer returned from that range came from a non-zero address, which means the sender already held tokens. Searching from block 0 found a 5 OUSD mint at block 25153426, and the first log of any kind at 25137271. Starting at the suggested block would have lost that mint, and reconciliation would have been off by a small amount. `start_block` is now 25137271.

**Blockscout's free rate limit is far tighter than expected.** It allowed about 10 pages, then returned 429 with `x-ratelimit-limit: 10` and a reset 22 to 36 minutes away. The first version backed off for about 30 seconds in total and then crashed. The client now reads `Retry-After` and `x-ratelimit-reset`, and pauses before the next request when a success spends the last of a window. The reset header's unit is inferred to be milliseconds from its size, not from documentation. Each rejected request may also push the reset further out, but we did not test that. A cold Ethereum backfill takes hours because of this.

**Tempo's documented 100,000 block limit is not usable at current volume.** Two separate problems appeared as logs got denser:

- Over 20,000 results, the RPC returns an explicit error. It does not truncate, so nothing is lost. The client now splits such ranges.
- Large responses often get a 502 from Cloudflare with `Retry-After: 60`. Measured over 10 requests per span: 100,000 blocks failed 7 times (responses up to 8.9 MB), 50,000 failed 2 times, 20,000 failed 0 times (up to 3 MB). This looked like a rate limit, and at one point `curl` succeeded while the pipeline failed, which sent us chasing HTTP versions, compression and connection reuse. None of those explained it. Size did. The range is now 20,000 blocks. The backfill went from a retry every few ranges to none.

**`executemany` was too slow.** About 0.86 ms per row is fine at 1,000 rows, but not at 20,000 per range, and the database stays locked while it runs. Binding one list per column and using `unnest` wrote 20,000 rows in 0.1 s.

**One unexplained stall, still unproven.** The very first Ethereum run stopped writing after about 2 minutes and sat idle for about 27 minutes until it was killed. Its output was buffered through `tail`, so there is no log of why, and the cause can't now be established. There are two candidates. One is a slow read, since the 60 second timeout only limits the gap between bytes. The other is a rate limit wait: 27 minutes is inside Blockscout's 22 to 36 minute reset, and the earliest committed client could already wait up to 30 minutes on a 429. Its warning would have sat in the same buffer. Both are now closed off. Each attempt has a 120 second deadline, tested against a real trickling socket, and every pause of 5 seconds or more logs its length. A silent gap now means a real hang. Don't pipe a long run through `tail`.

**A review of this code found bugs the tests had missed.** Each now has a test.

- **A reorg between two log ranges broke repair.** Repair assumes a stored hash commits to its ancestors, but hashes were stored one at a time with no link between them. When a fork landed between two ranges, the newest hash still matched, so repair saw nothing wrong. On the old code, if the new fork had a transfer in that block, every later sync failed with "changed during sync; rerun", forever. If it had none, a transfer that no longer existed stayed stored with no error. A new block must now extend the stored block below it.
- **Healing missed logs depended on timing.** The re-read only covered blocks near the current tip. Tempo's window is 16 blocks, so a log missed by a lagging node was lost for good unless the next run started within seconds. If it wasn't a mint or burn, reconciliation would never notice. Each run now re-reads the newest blocks below the cursor.
- **A short Blockscout page ended the range.** If the server's limit were ever below 1,000, everything after the first page would have been skipped and marked complete. A range now ends only on a response with nothing past its first block, at the cost of one extra request. Pages out of order or out of range now raise an error.
- **Blockscout could serve unfinalized blocks.** With finality stalled deeper than the 2,000 block tail, rows with no hash could land above finality. History now stops at finality.
- **A conflicting row was silently dropped.** `ON CONFLICT DO NOTHING` also hid a different row at the same position. It now raises. This adds about 15 ms per 20,000 rows at 2M stored rows.
- **Smaller ones.** A Bridge total given as a JSON number or with too many decimals was silently truncated, and now raises. Nothing checked `chain_id`, so a mispasted RPC URL looked like a quiet chain. Logs from another contract weren't rejected locally. Provider URLs reached logs, errors and `repr(Chain)`. A rate limit hint outlived its response and could repeat a long wait after an unrelated failure. A node lagging behind every stored block got advice to rebuild the database, which costs hours. `--chain tempo` listed Ethereum as neither checked nor missing. A sync after a long backfill finished hours behind the tip, too old for reconciliation on public nodes.

**Decision from the review.** The key stays chain, block and log index, though an early draft of the architecture said chain, transaction and log index. They identify the same rows on one EVM chain, and changing it would mean rebuilding a table in a live database for no gain. This was settled for Solana too: see the first full reconciliation below.

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

## The first full reconciliation, 2026-11-04

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

### Decision on the key

**The key stays chain, block or slot, and log index.** Solana's `log_index` is built from the transaction index and the position within the transaction, so it fits the same key, and no table needed rebuilding.

## The site, 2026-11-04

### What went wrong

**A bare `pnpm` crashed.** Corepack 0.34 from Homebrew looks for `bin/pnpm.cjs`, which pnpm 12 doesn't ship, and exits with "Cannot find module". The same crash can reappear in any local setup script that calls `pnpm` directly. The site now runs pnpm only through `npx`, at the one version in `web/package.json`'s `packageManager`, and the Makefile reads it from there. [Operations](operations.md#the-site) has the rule. This was checked on macOS only. Linux and the CI runner were not checked, and nothing relies on Corepack there.

**The newest TypeScript and ESLint left unmet peers.** TypeScript 7.0.2 and ESLint 10.14.0 both leave peer dependencies unmet in `eslint-config-next` and `typescript-eslint`. The site pins TypeScript 6.0.3 and ESLint 9.39.5, which have none. Move them together, and only when those two packages support the newer versions.

**Charts don't render to static HTML.** Recharts leaves an empty responsive wrapper in a static export. Every chart therefore has a text summary and a table that the server renders, and the chart is an addition to them.

**An ignored folder nearly hid code.** `.gitignore` matches `data/` at any depth, so a folder named `web/lib/data/` would have been silently untracked. Nothing under `web/` uses that name.

**The first dataset schema's wording promised more than a static page can do.** It described a failed run as marking the page stale. A failed run does mark the last published dataset stale, but a static page shows that only after it is rebuilt. Until then, only the clock tells a page it is old, and it does so once the data is more than 36 hours old, in the reader's browser. So a failed run can go unseen on a page that nobody rebuilds for up to 36 hours. The page now compares times with the reader's clock, and the daily hosted run is what rebuilds it.

### Known limits


### Acceptance

Acceptance ran on a local build from real dataset 20261104T163224Z and from the samples, at 320, 390, 768, 1056 and 1440 px.

- **Numbers:** a script compared the rendered pages with the dataset's JSON. 107 values match, 0 mismatch and 7 are observed only. A negative control, which tampers with values on purpose, was caught 4 times out of 4.
- **Accessibility:** axe found 0 serious or critical violations across 5 states, 2 pages and 5 widths.
- **Layout:** no page scrolls horizontally.
- **Also checked:** keyboard use, the skip link, a stale page by a fake clock and by a marked copy, reduced motion, JavaScript off, and no third-party requests.

### What went wrong in acceptance

- **The first report's number table was wrong, though the page was right.** It held values that are not in the dataset and marked them as matching. An independent rebuild caught it, and the comparison was redone by script.
- **Touch targets were too small.** Targets under 24 px in the header and on the methodology source links numbered 2 and up to 68 per page. They now number 0.
- **View A's dividers broke the design rule.** They were corrected.
- **Ethereum's velocity read 88.22% a day.** That is on a $2.8M circulating supply that burns had shrunk, so the figure misleads on its own. The page now carries a note taken from the dataset's warnings.
- **$454.5M of the $888.3M supply predates Day 0.** The page now says so.

### Not run

- A real screen reader.
- A physical touch device.
- A live refused publish on real data. That a failed check stops publishing is proved by tests and by a marked copy.
- Credits actually charged by the Solana provider are unknown.

## The dashboard rework, 2026-11-05

The main page became a dashboard with legends, keeping every finding visible and changing no number. This covers the build and the review rounds that followed.

### What went wrong

- **A floor rounded up in one place.** The supply view printed the exchange floor rounded down in its legend, as "at least" needs, but the bar's tooltip still used the compact figure: "$346.6K" for $346,579. A review caught it, and the tooltip now uses the legend's figure.
- **A caveat pointed at rows that weren't there.** The exchange-floor note said "the rows below", but the named rows sit under All's table toggle and on no single-chain panel. It now says "the named exchange rows".
- **Checks that read the same code as the page.** The panel checks in `verify-output` took what to expect from the functions the view renders, so a fault in those functions would have passed. The supply card's figures and wallet table are now also held to the KPI rows.
- **A link left with its card.** The active wallets definition link was on a card that was folded into the supply card, and wasn't carried over until review.
- **Narrow weekly figures ran into each other, then broke inside a number.** On one chain at 320 px, figures such as "$516.1K" were wider than their bar's column. The first fix let them wrap anywhere, and review found "$516." over "1K", which reads as $516. A figure now breaks only before its unit, and browser checks hold each figure over its own bar and each number on one line.
- **A pin could point at a row that wasn't drawn.** A chain with supply minted before Day 0 and no transfers since would have kept its Day 0 and small-ticket pins with no waterfall to sit on, and `verify-output` would then have refused the build. With no waterfall those notes now stay in the list with no pin.
- **"−$0".** A removal that rounds to nothing printed a minus sign on the per-chain waterfalls. It now prints "$0", as `formatCompact` does.
- **Checks that could pass on nothing.** Some browser checks passed with no rows to read, and the note check left out any marker anywhere in a note, so a planted second marker passed. Both are tightened, and the waterfall's figures are now also held to sums taken straight from the rows.
- **jsdom finds an id across the whole document.** A test that mounted the chain view twice found the second card missing, because `container.querySelector("#id")` returned nothing when an earlier mount held the same id. Tests that mount twice now use an attribute selector.
- **A grid that stacked where it fit.** The hairline table's rule stacks any table in a card under 720 px, which would have stacked the chain grid in every half-width card. The grid has its own threshold, and a browser check holds both chain cards inside themselves at every width.
- **A chart that couldn't be read on a phone.** The velocity chart's two fixed label columns left its bars 22 px of track at 320, so the comparison it exists for was lost. On a narrow card the measure's name now sits above its bar. That costs about 280 px of height at 390.
- **Checks computed by the code they check, again.** The first `verify-output` checks for the velocity chart and the grid took their expected figures from the same functions the views render. They now work the figures out from the KPI and chain roles rows on their own, as review had asked of the supply and activity checks.


### First whole-page review

- **A card clipped what floats out of it.** Sample and preview cards had `overflow: hidden` for their hatched edge, which would have cut any tooltip at the card's border. The edge now rounds its own corners, and nothing clips.
- **A card is its own stacking context.** Its container query contains it, so an open tooltip painted under the next card. The card with an open tooltip now rises over the cards after it, and stays under the sticky header.
- **A check counted hidden panels as moved.** The browser check that opening a tooltip moves nothing read each element's place on the page. A hidden filter panel has no box, so its place followed the scroll, and focus scrolling to a tooltip counted as 87 moves. Hidden elements are now left out.

### Third round

- **Badges by what they qualify, then footnotes.** With each badge moved onto the legend row or chart row it qualifies, opening a card's table took the chart, and so the exchange-floor badge, out of view, which the browser check on the exchange rows caught. The badges were then replaced with footnotes, whose list stays one tap away while the table shows.
- **A footer check read the tooltip with its link.** The check that a non-passing footer never says "Reconciled" read the status's whole text, where the link and its tooltip ran together with no space, so the word boundary could miss a planted "Reconciled". It now reads each element's words apart, with the tooltips left out.
- **The clock swap wasn't run on real data this round.** The real dataset was more than 36 hours old by the time of the run, so the build was already stale and had nothing to swap. The passing state was checked by `verify-output` on a build with its clock set to 5 Nov, and in screenshots.

### Fourth round

- **The supply card ignored the filter.** An earlier round had made it one card with every chain's bar, and its legend, figures, footnotes and tables stayed the first option's, so choosing a chain changed only which bar was marked. `verify-output` passed it because it held that one card to All's figures. Each option now has its own card, and `verify-output` holds every panel's legend and table to the dataset's rows, read without the page's supply code, so a chain's panel showing every chain's figures fails by name.
- **A named exchange on a chain's card.** The named exchange rows were across chains. A chain's card now lists only what `exchange_holdings` gives for that chain. Listings name no chain, so the name checks now allow each name once per row the page writes, not once in all.
- **A marker under the sticky header.** The first browser check of the footnote marker clicked one hidden under the sticky header and filter, so Playwright scrolled the page to reach it and the check read that as the marker's jump. The check now clicks only a marker that a hit test finds uncovered.
- **Scroll anchoring moved the page when a list opened.** A card's visually hidden summary is an absolute box with its static place after the card's content, so it moved down when the footnotes opened, and Chrome, holding the page still by it, scrolled the page by the list's height. That was part of the visible jump, and it threw off the drawer's own measurement at 320 and 390. Visually hidden text is now never a scroll anchor.
- **A muted bar faded its words.** Muting a whole bar faded the "Circulating" bracket and the direct labels with it, which the contrast check caught. Only the bar's fill fades now, and a muted bar's direct labels are hidden, as the legend has the chosen chain's.
- **A toggle that seemed to move.** Measuring the moved Table toggle on screen, it seemed to shift by up to 56 px when pressed. The card screenshot taken between the two measurements had scrolled the page. Measured against its card, or with nothing in between, the toggle doesn't move, and the browser check now measures it that way.
