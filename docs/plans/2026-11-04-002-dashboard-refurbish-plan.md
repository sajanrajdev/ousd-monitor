---
title: "feat: Dashboard refurbish of the site (Phase 4, units U1 to U6)"
type: feat
status: active
date: 2026-11-04
origin: docs/plans/2026-11-04-001-first-public-version-plan.md
---

# feat: Dashboard refurbish of the site (Phase 4, units U1 to U6)

## Overview

On review, the maintainer found the site too wordy and not intuitive. This plan turns the main page into a dashboard with legends, without hiding any finding. Words move and aren't deleted: findings stay visible on the page, and explanations appear on demand. It runs before the Phase 4 review, because that review should read the page people will see.

The numbers don't change. The dataset, its schemas, the metrics, the labels and the pipeline stay as they are. The site stays static, reading only the published dataset. This plan replaces the [Page structure](2026-11-04-001-first-public-version-plan.md#page-structure) section of the 001 plan, and everything else there stands. Nothing is deployed.

**Settled by the maintainer, not reopened here:**

- One scrolling page. No tabs, because tabs hide findings.
- Move words, don't delete them.
- No fun facts and no new facts. Only what the page says now.
- Start now, and stay flexible enough for exchange holdings to be added later. The holdings have since arrived, and U3 shows them. See [Exchange flexibility](#exchange-flexibility).

**Rule:** if a target and a limit disagree, the limit wins. A caveat stays on the page even if the word target is missed.

## Requirements trace

| Need | Source | Unit |
|---|---|---|
| Compact first screen: header, trust status, not-affiliated line, one-line headline, KPI row, findings row | Maintainer review | U2 |
| Chain filter in place of the five stacked bars | Maintainer review | U1, U3 |
| Responsive card grid, two columns on wide screens | Maintainer review | U1, U3, U4, U5 |
| Velocity as a chart, with a data-driven pin | Maintainer review, build log | U5 |
| Compact chain grid with in-cell bars | Maintainer review | U5 |
| Three explanation layers, none covering data | Maintainer review | U1 |
| Headings are findings of about 12 words at most | Maintainer review | U2 to U5 |
| Fact and Inferred as a small marker with a legend, always visible | Maintainer review, PRD section 9 | U1, U2 |
| About 450 visible words, under half the current height, nothing out of reach | Maintainer review | U6 |
| Takeaway, source, as-of time and definition link on every chart | R10 | U1, U6 |
| Not-affiliated line, stale state, sample and preview marks, refused and partial states stay visible | R8, R13, 001 plan | U1 to U6 |
| Exchange holdings shown without per-segment markup | Maintainer review | U3 |

## What was checked while planning

A build of the current site from a read-only copy of dataset 20261104T163224Z, measured in Chromium through Playwright, plus a throwaway page outside the repo. No repo file changed.

| Question | Result |
|---|---|
| Can the review's word count be reproduced? | **Yes.** `main`'s `innerText` split on whitespace at 1440x900, with all accordions closed, gives 1,489 words |
| Can the review's height be reproduced? | Nearly. `documentElement.scrollHeight` gives 6,676 px against the review's 6,695 px. U1 pins one method, and targets use its figure |
| Other current figures at 1440 | 9 tables (4 visible), 7 source lines, 11 "Inferred" chips. Verdict block 364 px. View A 2,521 px, view B 2,101 px, view E 709 px |
| Phone height at 390x844 | 12,858 px |
| Words in reach with every accordion open | 2,167 across the whole body |
| Current page weight | `index.html` is 184,793 bytes, 24,880 gzipped |
| Does a filter of native radios and CSS `:has()` work with JavaScript off? | **Yes,** in Chromium 156, with arrow keys moving between options |
| Do `<details name>` keep one panel open at a time with JavaScript off? | Yes, in the same browser |
| Can `:has(details[open])` swap a chart for a table and widen its card with JavaScript off? | Yes. The card went from 512 to 1,040 px at a 1056 viewport |
| Does `verify-output`'s JSDOM see inside `<noscript>`? | Yes. Children parse as elements, including links |
| Does a docs-only PR have room for new tokens? | **No.** `web/tests/tokens.test.ts` reads any table row whose first cell is a backticked token and requires it in `tokens.css`. New tokens are listed with a different first column until U1 adds them |
| Does Ethereum's velocity need a broken axis? | No. Velocity runs from 5.88% to 88.22%, with Solana at 34.73%, so a linear scale with direct labels stays readable |
| Is the Phase 3 number comparison in the repo? | **No.** It was a throwaway script outside the repo, described only in the PR for 3.6. U6 writes it again and commits it |
| Which token is the card grid's width? | `.page-main` already uses `--page-max-width`, and nothing uses `--page-content-width`. By that width and a 1rem gap, cards work out at about 472 px wide at 1056 and 648 px at 1440 |

**Not verified:** any of the pattern above in Firefox or WebKit, because only Chromium is installed here (U6 runs one pass in each). Recharts in a hidden panel (U3 mounts only the selected chart, so it shouldn't arise). The new page's real weight and height, which only exist once it's built.

## Target design

### Page structure

Main page, in order. There are still no tabs, and every card is on the page.

| Part | Contents | `data-section` |
|---|---|---|
| Sticky header | Mark, site name, not-affiliated line, methodology link. Unchanged | |
| Banner, if any | Sample or preview. Unchanged | |
| Trust status | One slim row directly under the header, with its detail disclosure | `trust-strip` |
| Headline block | Question line, one-line headline with its "Our reading" marker, as-of line | `verdict`, `question` |
| KPI row | Four cells: label, value, marker, info | `kpi-row` |
| Findings row | Four short cards, each a link to its chart | `findings` |
| Marker legend | One line, on the page's first screen | `marker-legend` |
| Chain filter | All, then each chain in the dataset. Sticky from 768 | `chain-filter` |
| Supply | Where supply sits, placed vs circulating | `view-a` |
| Activity | Headline to clean volume, everyday volume by week | `view-b` |
| Chains | Velocity by chain, what each chain does | `view-e` |
| Footer | Unchanged | |

**Above the fold, on real data:** at 1440x900, everything through the legend. At 390x844, through the KPI row, with the findings row starting. A sample or preview adds its banner and keeps `verdict.text` visible, so it may run longer.

### Cards and the filter

The grid is one column below 1056 and two from 1056. Each card has an anchor. `#supply-journey`, `#real-activity` and `#chain-roles-view` stay on their sections, because other pages may link to them.

| Card and anchor | Form | Under All | Under one chain |
|---|---|---|---|
| Where supply sits, `#where-supply-sits` | One stacked bar, then a config-driven legend with shares, then circulating and 7-day clean volume beside it | Summed at each chain's newest day. No wallet total | That chain's bar, with its active wallets beside it |
| Placed vs circulating, `#placed-vs-circulating` | Step lines | Chains summed | That chain's own lines |
| Headline to clean volume, `#headline-to-clean` | Waterfall rows | Day 0 through each chain's newest day | That chain's rows |
| Everyday volume by week, `#everyday-by-week` | Weekly bars | All chains | That chain, with the same week boundaries |
| Velocity by chain, `#velocity-by-chain` | Grouped horizontal bars, velocity, everyday and headline | All chains | All chains, with the selected chain highlighted |
| What each chain does, `#what-each-chain-does` | Grid: measures as rows, chains as columns, with in-cell bars and a lead marker | All chains | All chains, with the selected column highlighted |

The last two compare chains, so they highlight instead of dropping rows. Highlighting uses weight and a rule, never opacity, so contrast holds. The first screen isn't filtered: its figures are always across the chains it names.

A heading names its scope, so a filtered card can't be taken for the whole. A cropped card still says which chain it shows.

### Explanation layers

None covers data. All are native HTML, with a small client enhancement for hover and Escape.

| Layer | Opens by | Holds | Never holds | JavaScript off |
|---|---|---|---|---|
| **Info popover** | Hover, tap or keyboard | Definition, source, as-of repeat, definition link, the long takeaway, the text summary | A finding, a caveat needed to read a number, a state message | A `<noscript>` note shows source and definition in plain text |
| **Pin and note** | Always visible | A caveat, tied by number to a mark and naming the chain or part in words | A definition, or a figure that isn't in the dataset or already on the page | Unchanged |
| **Data toggle** | Tap, click or keyboard | The chart's table and any further tables | The only copy of a finding or caveat | Works natively |

**Essential** means findings and any caveat needed to read a number correctly. Essential text never sits only in a popover or a chart tooltip. The list for this page:

| Caveat | Where it stays visible | Condition |
|---|---|---|
| Ethereum's velocity note | Pinned on the flagged chain's bars | Any chain with a `circulating_supply` warning in the manifest, never a hard-coded name |
| Placed measures dollars that stayed, and unlabeled exchange custody can count as placed | Pinned on the placed segment | Always |
| A chain's issuer inventory reads as zero because nothing there is labelled | Pinned on the bar | `issuer_labeled` false on that chain |
| The series starts on the first valid placed day | Pinned on the step line | Always |
| Flows count from Day 0, and some supply predates it | Pinned on the waterfall | When `day0Scope` can state it |
| Hops across transactions count more than once, so clean volume can overstate | Pinned on the waterfall | Always |
| Bridge's small-ticket issuance isn't in the dataset, with its date and "unproven" | Pinned on the waterfall | Under All and Tempo |
| Few days of history: a direction, not a trend | Pinned on the weekly bars | Always, from `historyLabel` |
| Everyday means under $1M, nothing more | Pinned on the weekly bars | Always, from `definitions` |
| Velocity and headline velocity have different denominators | Pinned on the velocity chart | Always |
| We don't ingest swaps, so this can't show trading | Pinned on the chain grid | Always |
| Wallets, not people | Beside every wallet count, or in the caption of a table under a toggle | Wherever a wallet count shows |

**Until a later unit pins them,** these stay visible through the card's `note` prop, so no state of the page hides one. U1 did this for "Everyday means under $1M" and hops on the waterfall, as `data-note="everyday-meaning"` and `data-note="hops"`, and for "Wallets, not people" as `data-note="wallets-not-people"`. U2 gave the rest a kind: `placed`, `issuer-unlabeled`, `series-start`, `day-0-scope`, `small-ticket`, `history`, `velocity-denominators`, `velocity-warning` and `no-swaps`. From U2, `verify-output` fails the build if the dataset calls for one of these and it isn't in view or doesn't hold its words, so U3 to U5 keep the kinds when they pin them. The words live in `web/lib/takeaways/caveats.ts`, which the views and `verify-output` both read, and a kind on two cards is two required instances.

**The popover pushes and doesn't float.** The panel opens in flow under the card's or cell's head, so it moves the plot down and covers nothing. A floating panel would cover a chart, a KPI or a neighbouring card at some width, and the review ruled that out. The markup would be the same either way, so changing this is one CSS block. The maintainer sees it at the whole-page review after U5.

### How each limit is met

| Limit | How |
|---|---|
| **R10** | `ChartCard` still requires takeaway, source, as-of, definition and table, so a card missing one doesn't compile. The as-of stays visible in `.chart-card__meta`. Source and definition sit in the popover and in a `<noscript>` note. `verify-output` checks in the built page that the takeaway, marker, as-of time and frame word are in view and not empty, that source and definition link have values in both the popover and the note, and that each card has a table |
| **Fact, estimate and opinion kept apart** | Every card and KPI keeps a visible marker. The letter carries the meaning, and the outline style is a second cue. The full word is in the DOM for assistive tech. "Our reading" stays spelled out on the headline. A row or note that differs from its card carries its own marker |
| **Not-affiliated line** | Header and footer, unchanged. `verify-output` checks each on its own on every page, and text inside a `details` or `noscript` doesn't count |
| **Stale state** | The as-of line and trust status keep both texts and the same swap. Neither moves into a popover. Stale checks in `verify-output` don't change |
| **Sample and preview** | Banner, hatched edge, title word and `noindex` don't change. Every card keeps its word beside the as-of. The findings row gets one too, and `verify-output` adds that check. Headline chip stays "Sample, not a finding" |
| **Refused dataset** | The loader and build refusals don't change. Nothing new reads the dataset around them |
| **Partial dataset** | The filter lists only chains in the data. Its first option reads "All covered", never "All". Headings keep `scopeText`. `verdict.text` stays visible, because it carries the preview prefix and the estimated share. See [Headline wording](#headline-wording-open) |
| **Unknown values** | Takeaways, findings and bars return "Not enough data yet", never a zero |
| **Tooltips hold nothing essential** | The rule stays and now defines essential. Recharts' tooltip on the step line is the only one left, and it only repeats values the table has |
| **Popovers by tap and keyboard** | `<details>` and `<summary>` work by both, natively. Hover and Escape are enhancements, in one client component. Each trigger is at least 24 px and has a name |
| **Accessibility section** | The graphic stays `aria-hidden` and out of the tab order, so a pin inside it is a plain `aria-hidden` span and never a link. The text summary stays for assistive tech, visually hidden. U6 runs axe with every panel and toggle open, because axe skips closed content |
| **No Open Standard artwork** | No new artwork or asset. `tokens.test.ts` still scans for them |
| **No third-party requests, static site** | No new dependency. `verify-output` and a request log in U6 check it |

## Where the words go

Each row is current text and its new home. U6 proves this by script: see `compare-reach.mjs` in U6.

| Current text | New home |
|---|---|
| Question line | Visible, unchanged |
| Display sentence | Visible, smaller. Same words |
| "How we read this" link | Headline popover |
| `verdict.text` | Headline popover on real, four-chain data. Visible otherwise |
| "What this rests on" groups | Headline popover, still in their three groups |
| KPI notes and definition links | Each KPI's popover |
| KPI chips | Markers |
| Trust sentence | Visible, unchanged |
| "What this covers" and reconciliation detail | One disclosure on the trust row. Same words and table |
| View A's long takeaway | Popover. The short heading states the same finding |
| View A's summary | Popover, and visually hidden text for assistive tech. The same for every card's summary |
| Five stacked bars | One bar and the filter |
| Lists of small segments | The legend, every segment, every time |
| "Circulating, from activity data" | "Circulating" beside the bar, with the rest in the popover |
| Placed note | Short pin, with the full note in the popover |
| "How venues are labelled" | Popover |
| Step line note | Short pin, with the full note in the popover |
| "Per-chain values are in the first card's table" | Replaced by the filter, which does what it described |
| Clean volume and active wallets table card | Summed clean volume beside the bar, and the table under the first card's data toggle |
| Its summary and takeaway | First card's popover |
| Waterfall summary | Popover |
| "Large transfers are split out, not removed" | Popover. The rows "Clean large" and "Clean everyday" show it |
| Day 0 note, small-ticket note | Short pins, with both in full in the popover |
| Period table | Under the waterfall's data toggle |
| Weekly figcaption | "Weeks end on the date shown" in the popover. History label pinned |
| Velocity table | Under the velocity data toggle |
| Velocity explanation, jumpy note | Popover, with a short denominators pin |
| Velocity warning | Short pin with its date, both figures and its direction, with the full text in the popover |
| "Wallets, not people" | Visible beside the wallet counts, as on the [essential list](#explanation-layers), and in the table's caption |
| Chain roles table, including burned, placed share and "Leads on" | Under the chain grid's data toggle |
| Chain roles' long takeaway and summary | Popover |
| Every source line | Popover, and `<noscript>` note |
| Accordion titled "Table of the same data" | Data toggle |

**No new facts.** The heading, finding and pin texts below restate figures already on the page. In-cell bars and the velocity bars are geometry, and print no new figure. Per-chain views run the same functions over the dataset's own rows, so they add no metric.

## Word and height budget

**How it's measured,** by `web/scripts/measure-page.mjs`, the same way for the baseline and the result. Real dataset, viewport 1440x900 and 390x844, JavaScript on, fonts loaded, filter on All, every toggle and popover closed. Words are `main`'s `innerText` split on whitespace, leaving out `.sr-only`. Height is `documentElement.scrollHeight`.

| Measure | Now | Target | U6 pass line |
|---|---|---|---|
| Words in `main`, at 1440 | 1,489 | About 450 | 510 |
| Height at 1440 | 6,676 px | Under half | Under 3,338 px |
| Height at 390 | 12,858 px | Under half | Under 6,429 px |
| `index.html`, gzipped | 24,867 bytes | No target | Under 150,000 bytes |

**Words, counted from draft strings on the real dataset.** This is a draft, and the final count comes from U6.

| Part | Words |
|---|---|
| Trust status | 16 |
| Question line | 15 |
| Headline and marker | 13 |
| As-of and scope | 12 |
| KPI row | 17 |
| Findings row | 40 |
| Filter and marker legend | 11 |
| Where supply sits | 55 |
| Placed vs circulating | 41 |
| Headline to clean volume | 95 |
| Everyday volume by week | 48 |
| Velocity by chain | 73 |
| What each chain does | 65 |
| **Total** | **501** |

**This is above the target,** by about 11%. 136 of these words are numbers and dates, and the rest are mostly chart labels, headings and caveats the limits protect. The pass line above allows for this, and the target stays where it is. The next cuts, for the maintainer at the whole-page review after U5, each with a cost:

| Cut | Saves | Cost |
|---|---|---|
| Move the small-ticket pin to the popover | About 16 | The 001 plan put it in view because the verdict says supply sits still, and leaving it out would be one-sided |
| Drop "As of" and keep the date with a clock glyph | 12 | The date's meaning is less plain, and R10 is a binding limit |
| Move the Minted row to the table | 6 | The issuance lead marker needs a new home |
| Move everyday velocity values to the table | 5 | The PRD asks to show all three velocities |

## Headline wording: open

**The maintainer reviews final wording, and it isn't settled here.** The review noted that the headline says "at least half" while the KPI says 77.07%. A separate research task may change the placed figure, so a sentence fixed now could need changing again.

**The interim text rule, until the maintainer decides:**

1. The headline is `verdictSentence(verdict)` from `web/lib/verdict.ts`, unchanged. `VERDICT_SENTENCES` isn't edited by any unit in this plan.
2. It stays generated from the dataset's `verdict.state` and `verdict.scope`, with the same four states and the same "On {chains}:" prefix at partial scope. It's fail-safe in the same states as today, and carries no figure of its own. The figure sits in the KPI row beside it.
3. Its marker is "Our reading", or "Sample, not a finding" and "Preview, not a finding", exactly as today.
4. `verdict.text` renders verbatim. It may move into the popover only on real data at four-chain scope. On a preview, a sample or a partial scope, it stays visible, because it carries "Local preview, not a finding." or the estimated share.
5. The sentences may wrap on a phone or for the longer states, and are never truncated. "One line" is the budget for `mostly_placed` at 1056 and up.

A later change to wording touches `VERDICT_SENTENCES` and `web/tests/verdict.test.tsx`, and nothing else.

## Exchange flexibility

**The data now exists, and U3 uses it.** The maintainer accepted exchange option B, and exchanges may be named on the main page. `web/lib/supply-segments.ts` is the one mapping from a row to the bar, legend and table:

- **The exchange venues segment is a floor on every filter option.** `exchangeExtras` gives it `coverage: "floor"`, which reads "at least" in words and `≥` as the mark. Its amount prints as whole dollars rounded down, as a compact figure can round up past what "at least" allows.
- **`exchangeRows` from `web/lib/exchange-rows.ts` supplies its `entities`,** such as a row with its wallet count and floor, and a listed exchange with no wallet labeled. A row with wallets needs a public source tying the name to those wallets, so its source link goes to the named labels table. A listed exchange with no such source links to its own listing and claims no wallet.
- **The rows sit under All's data toggle,** in a `data-labels-table` block. They add up across chains, so a single chain's segment can be smaller than them, and `verify-output` allows each name once, as a row. A single chain's panel keeps the floor and no rows.
- **Exchange-linked is a band inside placed.** It reads `journey.placed_exchange_linked`, draws with its own pattern on placed's colour, isn't a venue and doesn't change placed. Its line keeps `data-exchange-linked` on each panel with a band, and each bar's client props keep `key` and `journey.placed_exchange_linked`, which `verify-output` reads in the page's payload. No wallet in the unnamed band is named.
- **The `exchange-floor` and `exchange-coverage` notes stay in view with their exact words.**

**Design requirement, as built.** Segments, their legend and their notes come from one config, with no per-segment markup. A segment has room for a coverage marker and for per-entity rows.

```ts
// web/lib/supply-segments.ts
type SegmentConfig = {
  key: string;
  label: string;
  style: SegmentStyle;
  marker: ChipKind;
  definition: DefinitionAnchor;
  circulating: boolean;
  band?: { key: keyof JourneyAmounts; label: string; image: string };
  notes?: (context: SegmentContext) => SegmentNote[];
};

// What the bar, legend and table read. Plain data, so it can reach a client component.
type SupplySegment = Omit<SegmentConfig, "band" | "notes"> & {
  amount: string;
  shareBps: number | null;
  coverage?: "floor";
  entities?: ExchangeRow[];
  band?: SegmentBand;
};

function supplySegments(row, extras?: SegmentExtras, config?: SegmentConfig[]): SupplySegment[];
```

**Fixture test,** named `web/tests/supply-segments.test.tsx`, using `web/tests/supply-exchange-fixture.ts`. It raises `venue_exchange` to about 40% of a `complete` row, lowers `placed_supply` by the same amount so the sums still hold, and passes rows for "Exchange A", "Exchange B" and "Exchange C". These are invented names. The fixture lives in the test folder and works on rows in memory, because the dataset's checks refuse rows that don't match its labels. See [U3](#u3-supply-views) for what it asserts.

**Still true of any later change:**

- `verify-output` allows a labelled entity's name on the main page only as the name of an exchange row. Each row must match the dataset's name, figure and source, and every other labelled name stays blocked. The check reads `data-exchange-row` inside a closed disclosure too, but it refuses a hidden row, and from U3 it requires the rows under All's toggle.
- A larger exchange segment lowers placed. That can change `verdict.state`, and so the headline, by design.
- New fields arrive through a schema change and generated types. `supplySegments` is the one function that then changes.

## Key decisions

- **The filter is native radios and CSS, with all panels server-rendered.** It works with JavaScript off, has keyboard behaviour for free, needs no client copy of the `BigInt` code, and leaves every number in the static HTML for `verify-output` and the comparison script. The cost is page weight, which U3 measures against the pass line above.
- **Filtering runs the same functions over each chain's rows.** The waterfall, weekly bars and step line aren't shown per chain today. They're the dataset's own rows through the code the page already trusts, so this adds no metric or claim. If the maintainer reads "no new facts" more narrowly, those three panels drop out and those cards stay on All, with a label saying so.
- **Popovers and data toggles are `<details>`.** This follows the `Accordion` precedent: keyboard and screen reader behaviour for free, and content in the static HTML. `name` keeps one popover open at a time.
- **Without `:has()`, nothing is hidden.** Panel-hiding rules sit inside `@supports selector(:has(*))`, so an old browser shows every panel, long but complete.
- **The trust status sits directly under the sticky header, not in it.** The stale sentences are too long for the header, and the phone header has a budget of 88 px. Together they read as one compact band, and only the header stays sticky.
- **The velocity chart uses a linear axis from zero, with direct labels.** No broken axis and no log scale. The pin explains the outlier. A chain's pin comes from `manifest.warnings`, so it can't go false when the data changes.
- **Velocity bars are hand-built marks, as the waterfall is.** So only the step line needs JavaScript, and the caveat's pin sits in static HTML.
- **Wallet counts are still never summed,** so All shows none and a single chain shows its own.
- **A finding is the chart's own heading, from the same function.** Two sentences can't disagree if there's only one. It costs some repeated words.
- **Clean volume and active wallets stay with the supply card.** The PRD says the stack has them "beside it", so they don't move to the velocity card and the PRD doesn't change.
- **The chain grid transposes.** Measures become rows and chains columns, so the five `leading_for` measures map to five rows with a lead marker. It fits a half-width card. Bars scale to each row's largest value, and print nothing new.
- **Tables stack by the card's width, not only the viewport's.** They stack in any card narrower than 720 px, because a half-width card is too narrow for the current rule, which reads only the viewport. A card with an open data toggle spans both columns from 1056, so the 13-column table can read as a table. The viewport rule stays for tables outside cards, such as the methodology page and the trust row.
- **Markers are letters, spelled out in the legend.** F, I and E, with the full word in the DOM. A cropped card still has a marker, and its popover explains it. `.status-chip` and `data-kind` stay, as tests and `verify-output` read them.
- **Workers are named by role.** Project rules keep tool and product names out of repo files.
- **No new dependency.** Everything here is native HTML, CSS and existing packages.

## Output structure

```
Makefile                               web-acceptance
docs/design-system.md                  tokens move to their tables in U1
docs/build-log.md  docs/implementation-plan.md  README.md    U6
web/
  app/        page.tsx  layout.tsx  globals.css  tokens.css
  components/ info-popover  explain-enhance  pinned-notes  data-toggle
              chain-filter  chain-panels  marker-legend  findings-row
              status-chip  chart-card  verdict-block  kpi-row  trust-strip
              views/journey  views/journey-charts  views/activity  views/activity-charts
              views/velocity  views/velocity-chart  views/chain-roles
  lib/        chain-scope.ts  supply-segments.ts  verdict.ts
              takeaways/journey.ts  takeaways/activity.ts  takeaways/chain-roles.ts
  scripts/    verify-output.mjs  shots.mjs  measure-page.mjs  acceptance.mjs
              compare-numbers.mjs  compare-reach.mjs
  tests/      one file per component above, and supply-exchange-fixture.ts
```

## Implementation units

### Order and overlap

```
U1 shared components --> U2 first screen --> U3 supply
                                              |
                                              v
         U6 acceptance <-- maintainer review <-- U5 chains <-- U4 activity
```

Every unit runs alone, in this order. U4 and U5 both touch `views/activity.tsx` and `takeaways/activity.ts`, so they don't overlap. Between units the page mixes old and new parts, which is fine, because nothing is deployed. Evidence follows [the 001 plan's rules](2026-11-04-001-first-public-version-plan.md#evidence-for-web-prs), and number claims in any PR come from script output.

Each PR's scope is `phase-4`, for example `feat(phase-4): add the first screen`.

---

- [ ] <a id="u1-shared-components"></a>**Unit U1: Shared components**

**Goal:** the card, info popover, pins and notes, data toggle, chain filter, marker and legend, plus the tools that measure them. The page looks almost the same after this unit, except that existing cards use the new parts.

**Dependencies:** none.

**Suggested worker:** a frontend engineer strong on accessibility and native HTML. High effort, as every later unit builds on this.

**Files**
- Create: `web/components/info-popover.tsx`, `web/components/explain-enhance.tsx`, `web/components/pinned-notes.tsx`, `web/components/data-toggle.tsx`, `web/components/chain-filter.tsx`, `web/components/chain-panels.tsx`, `web/components/marker-legend.tsx`, `web/lib/chain-scope.ts`, `web/scripts/measure-page.mjs`, `web/scripts/acceptance.mjs`, `web/scripts/local-browser.mjs`
- Modify: `web/components/chart-card.tsx`, `web/components/status-chip.tsx`, `web/components/views/journey.tsx`, `web/app/layout.tsx`, `web/app/globals.css`, `web/app/tokens.css`, `web/scripts/verify-output.mjs`, `web/scripts/shots.mjs`, `web/package.json`, `Makefile`, `docs/design-system.md`
- Test: `web/tests/info-popover.test.tsx`, `web/tests/pinned-notes.test.tsx`, `web/tests/data-toggle.test.tsx`, `web/tests/chain-filter.test.tsx`, `web/tests/marker-legend.test.tsx`, `web/tests/chain-scope.test.ts`, `web/tests/chart-card.test.tsx`, `web/tests/shell.test.tsx`, `web/tests/verify-output.test.ts`

**Approach**
- **Tokens:** add those listed under "Tokens the refurbish adds" in `docs/design-system.md` to `tokens.css`, and move their rows into the design system's real tables in the same change, as `tokens.test.ts` requires.
- **`ChartCard`:** the same required props, plus optional `notes: PinnedNote[]`, `id`, `detail` (more for the popover: a long takeaway or a note in full), `moreTables` (further tables under the toggle) and `needsJs`, because U2 to U4 fill these and don't change this file. It renders the heading, marker, popover, plot, notes, data toggle and visible meta. `note` stays until U5, so old views keep working. The visually hidden `summary` stays for assistive tech.
- **`.chart-card__meta`:** holds the as-of `time` and the frame word, always visible. Source and definition link move into the popover and the `<noscript>` note.
- **Info popover:** a `<details name="info">`. The `<summary>` is placed into a corner the head reserves, and the panel flows beneath the head. Panel text is at least `--text-small`. Its trigger is at least 24 px, with an `aria-label` naming the card.
- **`explain-enhance`:** one client component, mounted once in the layout, with delegated listeners and nothing else. With a mouse, hover opens after a short delay, and leaving closes after a short delay unless it was clicked open. The first click on a hover-opened panel keeps it open rather than closing it. Escape closes, and returns focus to the trigger only when focus is inside the popover or on nothing, so it can't scroll the page away from a reader who has moved on. Outside clicks close. Clicking a finding link sets the filter to All. A reader without it loses none of the content.
- **Pins and notes:** `Pin` is an `aria-hidden` span for inside a graphic, never focusable. It takes the notes list and a note's kind, and its number comes from `pinNumber`, so a note that drops out can't leave a wrong number. `PinnedNotes` is an ordered list outside the graphic, with visible numbers. Each note names its chain or part in words, so it reads without the pin. Notes sit beside the plot when the card is at least 560 px wide, and below it otherwise, by container query. They are never in a `<details>` or `<noscript>`.
- **Data toggle:** a `<details>` whose `<summary>` swaps "Table" and "Chart" by CSS. `:has()` hides the plot and notes stay visible. From 1056, the card with an open toggle spans both columns.
- **Chain filter:** a `<fieldset>` of radios with a visually hidden legend, styled as a segmented control, with targets at least 36 px tall. `chain-scope.ts` turns `chains_included` into options, with "All" at four chains and "All covered" otherwise. `ChainPanels` renders one panel per option, and CSS shows the selected one. Hiding rules sit inside `@supports selector(:has(*))`, and outside it the filter itself is hidden and the toggle keeps saying "Table", as neither could do what it says. Each panel holds a whole card, so the card's frame word and meta come with it.
- **Live region:** `explain-enhance` updates one polite status line when the filter changes, because a screen reader hears the radio and not the panel. Without JavaScript, the radio is announced as usual.
- **Marker:** `StatusChip` shows F, I or E with the full word in `.sr-only`. `opinion` stays in words. `data-kind` and `.status-chip` don't change. `MarkerLegend` reads "F Fact, I Inferred, E Estimate" with a popover explaining all four and linking `#fact-estimate-opinion`.
- **Tables:** add a stacking rule at a card width under 720 px beside the viewport rule, using `container-type: inline-size` on the card. The viewport rule stays for tables outside cards.
- **Without JavaScript:** a chart that needs it says "This chart needs JavaScript. The Table button has the same data.", since the table no longer sits below it.
- **`verify-output`:** text counts as in view only outside any `details` body, `noscript`, `[hidden]`, `.sr-only` or inline hiding, and the independence line, banner, stale note, as-of, trust status and frame words are all read that way. `checkCards` requires a non-empty takeaway and marker in `.chart-card__head`, and a non-empty `time[datetime]` in `.chart-card__meta`, all in view. It requires a "Source:" with a value and a `/methodology/#id` link both in the popover panel and in a `<noscript>` note, and a table. A chart with nothing in the static HTML must have its JavaScript note. A new check fails any `[data-pinned-notes]` inside a `details` or `noscript`.
- **`measure-page.mjs`:** the method in [the budget](#word-and-height-budget). Run it on a build of the current site in this unit's PR, to pin the baseline.
- **`acceptance.mjs`:** local only, never called by `make check`, through `make web-acceptance`. It takes built folders, and each later unit adds checks. It starts with the browser checks for this unit. The filter, legend and grid aren't on the page until U2 and U3, so it renders those real components with made-up amounts into the built page, under `[data-harness]`. Each later unit drops the part it mounts for real.

**Test scenarios**
- Happy path: a card renders heading, marker and visible as-of. Source and definition are in the panel, and in `noscript` when parsed as `verify-output` parses it.
- Compile: a `ChartCard` missing source, as-of, definition, summary or table fails type-checking (`@ts-expect-error` in the test).
- Happy path: the popover's trigger has a name and the panel's definition link has the right `href`.
- Error path: `verify-output` fails on a planted card with its source only in the popover and none in `noscript`, on one with its as-of inside a `details`, and on pinned notes inside a `details`.
- Happy path: `PinnedNotes` lists numbers matching `Pin`, and no pin is focusable. Axe has no violations with a pin inside `aria-hidden`.
- Happy path: the marker's full word is in the DOM, and `opinion` with a frame word reads "Sample, not a finding".
- Edge case: `chain-scope` gives "All covered" and two chains for `partial`, and "All" and four chains for `complete`.
- Browser, in `acceptance.mjs`, at 320, 390, 768, 1056 and 1440, with JavaScript on and off:
  - choosing a filter shows one panel, and arrow keys move between options
  - one popover opens at a time
  - an open popover's box intersects no plot, value or note of any card
  - hover opens, moving onto the panel keeps it open, Escape closes and returns focus, and a click pins it
  - tap opens with touch emulation
  - the toggle swaps chart for table, and focus stays on it
  - targets are at least 24 px
  - no page scrolls sideways with every toggle open, and every table and panel fits inside its card
  - with nothing open, headings, markers, meta lines, pins, the independence line, banner and stale note are all really visible, whatever a stylesheet does
  - focus shows an outline, and the chosen filter option looks different, in forced colours too
  - Escape from elsewhere closes the popover and leaves focus and scroll alone
  - with the `:has()` rules off, the filter is hidden, every panel shows, and the toggle doesn't say "Chart"
  - axe with toggles closed and open, and contrast with the frame's edges off and the graphic included

**Verification:** `make check` is green. `## Evidence` has the measure script's baseline output, and one card at 390 and 1440 with its popover and its toggle open, on the sample.

---

- [ ] <a id="u2-first-screen"></a>**Unit U2: First screen**

**Goal:** a reader gets the answer, the figures and the findings on one screen, with trust and independence in view.

**Dependencies:** U1.

**Suggested worker:** a frontend engineer careful with copy and generated text. Medium to high effort.

**Files**
- Create: `web/components/findings-row.tsx`
- Modify: `web/components/verdict-block.tsx`, `web/components/kpi-row.tsx`, `web/components/trust-strip.tsx`, `web/lib/verdict.ts`, `web/lib/takeaways/journey.ts`, `web/lib/takeaways/activity.ts`, `web/lib/takeaways/chain-roles.ts`, `web/components/views/journey.tsx`, `web/components/views/activity.tsx`, `web/components/views/chain-roles.tsx`, `web/app/page.tsx`, `web/app/globals.css`, `web/scripts/verify-output.mjs`, `web/scripts/acceptance.mjs`
- Test: `web/tests/findings-row.test.tsx`, `web/tests/verdict.test.tsx`, `web/tests/kpi-row.test.tsx`, `web/tests/trust-strip.test.tsx`, `web/tests/frame.test.tsx`, `web/tests/takeaways-journey.test.ts`, `web/tests/takeaways-activity.test.ts`, `web/tests/takeaways-chain-roles.test.ts`, `web/tests/verify-output.test.ts`

**Approach**
- **Trust status:** the same sentences and marker, one slim row at the top of the first screen. "What this covers" and "Reconciliation detail" become one disclosure with the same text and table. `data-section="trust-strip"` stays.
- **Headline block:** the question line, then the headline at `--text-headline`, the "Our reading" marker, an info popover, and the as-of line. Follow [the interim text rule](#headline-wording-open). The popover holds "How we read this", `verdict.text` where allowed, and `verdictGroups`. Add `verdictTextVisible(verdict, state)` to `web/lib/verdict.ts`. `VERDICT_SENTENCES` doesn't change.
- **KPI row:** label, value and marker in each cell, with the note and definition link in its popover. "Across {chains}." and the frame word stay visible. The as-of line above covers the KPI's date, and the build's check of it stays. The date moves into each popover as the as-of repeat, so its words stay in reach, and comes back to the visible line if the KPI rows' days ever differ from the line above. With JavaScript off the note and link also show as a plain note.
- **Findings row:** four cards, each a whole-card link carrying `data-finding-link`, which is how `explain-enhance` knows to set the filter to All, with a heading's text and its marker. Each card carries the frame word and hatched edge on sample and preview, so one cropped alone reads as not real. Add `journeyHeading`, `waterfallHeading`, `weeklyHeading` and `chainRolesHeading` beside the long takeaways, which stay for popovers. The four cards take these as their own headings now, with the long takeaway in the popover, so a finding and the card it lands on can't disagree. Worded for the real dataset:

  | Function | Text on dataset 20261104T163224Z | Words |
  |---|---|---|
  | `journeyHeading` | 77.07% of supply stayed 14+ days in $1M-plus wallets. | 9 |
  | `waterfallHeading` | $1.4B of $5.1B headline transfers is clean volume (27.97%). | 9 |
  | `weeklyHeading` | Everyday clean volume: $32.1M over 7 days to 3 Nov, $24.5M before. | 12 |
  | `chainRolesHeading` | Tempo leads on four measures; Solana on everyday volume. | 9 |

  These state only what's on the page now, and each function reads its figures from the dataset. Thresholds and days come from `definitions`. Past two named chains, `chainRolesHeading` reads "Leadership is split across {n} chains." It reads the same for two chains that each lead on a measure of their own and also tie on another, as no shorter sentence holds all three. A tie names both chains. `weeklyHeading` dates its block, as blocks count from the data's first day and can end up to 6 days before its newest, so "last 7 days" and "week" would both misdescribe it. Partial scope prefixes "On {chains},". Null gives the unknown text.
- **Anchors:** put the new card anchors on the current cards now, so the links work before U3 to U5. They live in `CARD_ANCHORS`, so a finding's link and its card share one name.
- **Marker legend:** mounted at the end of the first screen.
- **`verify-output`:** add `findings` to what must carry the frame word on sample and preview, and require every finding link's target to exist on the page. It also requires that a finding match its target card's heading and marker, that the headline be the verdict's sentence, that `verdict.text` be verbatim, in view unless `verdictTextVisible` allows the popover, that every verdict item and the trust row's "doesn't verify" caveat stay in their panels, and that the KPI cells, legend and essential caveats below are in view. The caveats' check moves here from U5, as this is the unit that first moves words off the page. It recomputes the four headings and the four KPI values from the dataset, so a finding and its card can't be wrong together, and it checks each required caveat instance's words, not only that a note of its kind exists.

**Test scenarios**
- Happy path: each of the four verdict states gives today's sentence, unchanged, compared with a copy of the four in the test, so a change to `VERDICT_SENTENCES` has to edit the test too.
- Edge case: partial scope prefixes the chains, and never says "all".
- Happy path: `verdict.text` is visible on `complete` and `partial`, and in the popover on a real four-chain dataset. On a preview its "Local preview, not a finding." prefix is on screen.
- Happy path: each heading is at most 12 words on `complete`, plus its scope prefix on `partial`. Tested at boundaries, zero, null and one chain.
- Edge case: `chainRolesHeading` with no leader, one leader on all five measures, a tie and three leading chains.
- Happy path: a large placed change flips the heading's figure with no other edit, because it reads the dataset.
- Happy path: each finding link resolves to an id on the page. The row has the frame word on sample and preview.
- Happy path: the placed share in the KPI, finding and `verdict.text` agree, with the same floor as today's test.
- Trust status, one test per state, kept from 3.2: fresh, stale by clock, `manifest.stale`, preview and sample. The fresh sentence appears only in fresh.
- Browser, on real data: at 1440x900 everything through the legend is above the fold. At 390x844 the KPI row is, and findings start. The as-of swaps with no layout shift under a fake clock.

**Verification:** `## Evidence` has the first screen at 390 and 1440 on the sample, real-data script output, and a popover open on a KPI. The maintainer reviews real data on localhost, so no real-data image is published.

**Maintainer review.** The maintainer has seen this first screen and lifted the stop that followed it, so U3 to U5 proceed without a separate stop. The maintainer reviews the whole page on real data after U5, including the push-down popover; the letter markers and legend; the [word budget](#word-and-height-budget) and its next cuts; the per-chain filter decision in [Key decisions](#key-decisions). The headline wording can stay open past that review.

---

- [ ] <a id="u3-supply-views"></a>**Unit U3: Supply views**

**Goal:** the filter on the page, with where supply sits and placed vs circulating as config-driven cards.

**Dependencies:** U2.

**Suggested worker:** a frontend engineer comfortable with charts and exact amounts. High effort, as the exchange test and filter both land here.

**Files**
- Create: `web/lib/supply-segments.ts`, `web/tests/supply-exchange-fixture.ts`
- Modify: `web/components/views/journey.tsx`, `web/components/views/journey-charts.tsx`, `web/lib/takeaways/journey.ts`, `web/app/page.tsx`, `web/app/globals.css`, `web/scripts/acceptance.mjs`, `docs/design-system.md` if a token is needed
- Test: `web/tests/supply-segments.test.tsx`, `web/tests/journey.test.tsx`, `web/tests/takeaways-journey.test.ts`, `web/tests/frame.test.tsx`

**Approach**
- **`page.tsx`** gets a `.dashboard` wrapper holding the filter and the three view sections, each a two-column grid from 1056. The filter is sticky from 768, and `scroll-padding-top` grows to clear it. U4 and U5 only replace their view's content.
- **Where supply sits:** `SupplyBars` draws one bar from `supplySegments`. Direct labels on segments at or above today's threshold. The legend lists every segment, with share, marker, coverage and pin, including zero, so it doesn't jump between filter options. Bracket for circulating. Beside the bar: circulating and 7-day clean volume, and under a single chain its active wallets. No all-chain wallet total.
- **Table:** the current supply table and the "Last 7 days, per chain" table, both under the data toggle. Per-entity rows, if any, in a `data-labels-table` block in the same place.
- **Placed vs circulating:** `SupplySeries` for each filter option. Only the selected panel mounts Recharts, listening for the filter's `change`. The others keep the skeleton. Three y ticks, fewer x ticks, and a `seriesHeading` function: "Placed share: 33.84% on 14 Oct 2026, 77.07% on 3 Nov."
- **Notes:** the placed and `issuer_labeled` notes from `SegmentConfig`, and the start-of-series pin.
- **Findings with JavaScript off:** a finding's link resets the filter only through `explain-enhance`. With a chain selected and JavaScript off, it can land on a hidden card. U3 mounts the filter, so U3 makes this safe, for example with a rule that shows a targeted card's panel, and `acceptance.mjs` checks it with JavaScript off.
- **Weight:** report the gzipped page against the pass line in this PR.

**Test scenarios**
- **The named fixture test,** `web/tests/supply-segments.test.tsx`, with a large exchange segment and per-exchange rows:
  - the exchange segment takes its share of the bar with a direct label, and its legend row appears with no change to any component
  - the coverage marker shows the total as a floor, with "at least" in words as well as the mark
  - rows for "Exchange A", "Exchange B" and "Exchange C" appear under the data toggle, each with its source link
  - the bar's parts still sum to total supply to the base unit
  - `journeyHeading` and circulating recompute from the changed amounts, with no edit
  - a new segment added only to the config appears in bar, legend and table, proving there's no per-segment markup
  - entity rows that sum above their segment are refused, so a segment can't be smaller than its own rows
- Happy path: without `extras`, no coverage marker or entity row appears anywhere.
- Happy path: every filter option renders its bar, legend, table and heading, with the sample's values. Under a single chain, the heading names it.
- Happy path: no all-chain wallet total in any panel.
- Edge case: a chain at zero supply gives the unknown text with no chart and no division by zero. A segment at 0 shows `$0`, not a gap.
- Edge case: `issuer_labeled` false shows its pin under All and that chain's panel, and no other chain's.
- Edge case: an empty step-line series gives the unknown text.
- Browser: changing the filter draws the step line at full width with no console error, and nothing shifts above the grid. Sticky filter doesn't cover an arriving anchor at any width.

**Verification:** `## Evidence` at 390 and 1440, every filter option at 1440, and the fixture's bar from a test render on the sample.

**As built, where it differs from the above:**

- **Notes on the two supply cards sit under the chart, not beside it.** These two cards have a legend beside the chart, so the notes take the card's width, in two columns from 560. The floor note is too long for a narrow column. `ChartCard` gains one optional prop, `beside`, for the legend and figures, which sit outside the hidden graphic, so assistive tech reads them. The rule stays as written for a card with no `beside`.
- **The chart on these two cards is `--chart-height-phone` at every width,** so a half-width card stays compact. It is still reserved before it draws.
- **The placed and step-line notes in view are short forms,** `PLACED_PIN` and `seriesStartPin`, as [Where the words go](#where-the-words-go) says. `verify-output` holds each short form to its exact words and requires the full note in that card's popover, on every panel. "Per-chain values are in the first card's table" is gone, as the filter does what it described.
- **The "Clean volume and active wallets" card is gone,** replaced by the figures beside the bar and its table under the toggle, as the words table says. Under All there's no wallet figure, and its caveat stays in view.
- **The view sections take `card-grid`,** a one-word change in `views/activity.tsx` and `views/chain-roles.tsx`. A card left alone on its row takes the row, so velocity and chain roles leave no hole until U4 and U5.
- **The waterfall's period table still stacks in its half-width card until U4** moves it under the toggle, so that row is tall for now.
- **The whole-page `verify-output` tests are in `web/tests/verify-output-panels.test.ts`,** not `verify-output.test.ts`. That file's heap grows by about 5 MB a test, and 20 tests that each parse a whole main page several times ran its worker out of memory in CI.
- **A finding with JavaScript off** lands on its card's All panel, by `:target` inside `@media (scripting: none)`. That card then stays on All until another link is followed, and its heading says what it covers.

---

- [ ] <a id="u4-activity-views"></a>**Unit U4: Activity views**

**Goal:** headline to clean volume and everyday volume by week as dense, filterable cards.

**Dependencies:** U3.

**Suggested worker:** a frontend engineer comfortable with exact amounts. Medium effort, as U3 sets the pattern.

**Files**
- Modify: `web/components/views/activity.tsx`, `web/components/views/activity-charts.tsx`, `web/lib/takeaways/activity.ts`, `web/scripts/acceptance.mjs`
- Test: `web/tests/activity.test.tsx`, `web/tests/takeaways-activity.test.ts`

**Approach**
- **Waterfall:** the same rows, order and hatching, sized for a half-width card. `waterfall(rows)` runs per filter option. The table and `PeriodTable` go under the toggle.
- **Pins:** Day 0, hops and small-ticket, short form visible and full form in the popover. Hops and "under $1M" keep their `data-note` kinds, `hops` and `everyday-meaning`, when they move from the waterfall's `note`. Small-ticket shows under All and Tempo only, because it compares with Tempo's volume.
- **Weekly bars:** `weeklyEveryday` per filter option, with week boundaries always anchored to the all-chain first day, so a week means the same dates under every filter. History and "under $1M" pinned.
- **Velocity stays here until U5.** It moves out in U5, so its card isn't changed in this unit.

**Test scenarios**
- Happy path: waterfall steps sum back to headline exactly, under All and each chain, and the bars equal clean large and clean everyday.
- Edge case: a part at 0 keeps its row, and a $21 fee beside a $5B headline keeps a readable label.
- Edge case: a chain's parts not summing to headline give the unknown text, as `waterfall` does today, and not a partial chart.
- Happy path: per-chain weekly amounts sum to the all-chain amount for every complete week.
- Edge case: a chain that starts late gets the same week boundaries as All. A chain a day behind doesn't make a week look smaller.
- Happy path: the small-ticket pin renders under All and Tempo with its date and "unproven", and under no other chain.
- Happy path: the words "trading volume" don't appear, and no text says what transfers were for.
- Happy path: `weeklyHeading` and `waterfallHeading` per filter option name the chain.

**Verification:** `## Evidence` at 390 and 1440, with one chain selected. The waterfall reads top to bottom at phone width, and hatching shows.

**As built, where it differs from the above:**

- **"Everyday means under $1M" is pinned on the weekly bars only,** as the [essential list](#explanation-layers) places it, and stays in the waterfall's popover through its summary. It is pinned on every weekly panel, always, so `verify-output` no longer ties it to the waterfall.
- **The short forms in view** are `SMALL_TICKET_PIN`, `day0Pin` and `historyPin` in `lib/takeaways/caveats.ts`. Each keeps its date or figures, and "unproven" for small-ticket. The full forms sit in that card's popover under `data-full-note`, held there by `verify-output`. Hops is one sentence already, so its pin is its whole text.
- **Pins on the waterfall sit on the row the note is about:** Day 0 on headline volume, small-ticket on issuer flows, hops on clean large. The weekly bars carry their two pins in the chart's corner, as both notes are about every bar.
- **Per-chain figures come from `lib/activity-panels.ts`,** which the view and `verify-output` both read, as U3 did with `supply-segments.ts`. `verify-output` checks each panel's rows, pins, notes, full notes and tables.
- **Day 0's scope under one chain** is `day0Scope` run on that chain's rows and KPI row, so it says that chain's own figure, and shows only when that chain's mints and burns add up to its supply.
- **A note's marker isn't one of its words.** `verify-output` reads notes without their markers, and checks a pinned note's marker on its own.

---

- [ ] <a id="u5-velocity-and-chain-views"></a>**Unit U5: Velocity and chain views**

**Goal:** velocity as a chart with its caveat pinned, and chain roles as a compact grid.

**Dependencies:** U4.

**Suggested worker:** a frontend engineer strong on data visualization and honest labelling. High effort, as the caveat rule is enforced here.

**Files**
- Create: `web/components/views/velocity.tsx`, `web/components/views/velocity-chart.tsx`
- Modify: `web/components/views/activity.tsx`, `web/components/views/chain-roles.tsx`, `web/components/chart-card.tsx`, `web/lib/takeaways/activity.ts`, `web/lib/takeaways/chain-roles.ts`, `web/app/page.tsx`, `web/app/globals.css`, `web/scripts/verify-output.mjs`, `web/scripts/acceptance.mjs`
- Test: `web/tests/velocity.test.tsx`, `web/tests/activity.test.tsx`, `web/tests/chain-roles.test.tsx`, `web/tests/takeaways-activity.test.ts`, `web/tests/takeaways-chain-roles.test.ts`, `web/tests/verify-output.test.ts`, `web/tests/chart-card.test.tsx`

**Approach**
- **Velocity chart:** four chains, three bars each: velocity, everyday, headline. A linear axis from zero to the largest value, with direct labels, and pattern as well as colour between measures. Server-rendered, so it needs no JavaScript.
- **Flag:** any chain in `velocityWarnings` gets a numbered pin beside its name. No name is hard-coded. On today's dataset that is Ethereum. The note's short form keeps its date, both figures, its direction and "shouldn't be read as a trend". The long form stays in the popover.
- **Heading:** `velocityHeading`, the first sentence of today's takeaway: "On Solana, velocity is higher than headline velocity." A second pin carries the denominators.
- **Table:** today's velocity table, unchanged, under the toggle.
- **Chain grid:** a real `<table>`, with measures as rows and chains as columns, on a `ChartCard` with `plotIsContent`, because a table with words for assistive tech can't sit in the hidden graphic. Share of supply, minted in 30 days, everyday share, DEX flow share, lending flow. In-cell bars scale to each row's largest value. A lead marker comes from `leading_for`, with its meaning in words for assistive tech. A row of as-of days appears only when chains differ. Below the card-width rule, each measure stacks with four label and value pairs.
- **Table:** the current chain roles table, with burned, placed share and "Leads on", under the toggle.
- **Heading:** `chainRolesHeading` from U2. The no-swaps note is pinned.
- **Cleanup:** remove `note` from `ChartCard`. `TableCard` stays for the methodology page's two cards, so remove only what the main page no longer uses.
- **`verify-output`:** U2 already requires, for each `circulating_supply` warning in the manifest, a `data-note="velocity-warning"` for that chain outside any `details` and `noscript`, and the same for the rest of the [essential list](#explanation-layers). So here the notes keep their kinds when they become pins, and this unit adds any that U5's own pins introduce.

**Test scenarios**
- Happy path: a warning on one chain gives one pin and one note, naming that chain. A warning on another chain moves them, with no code change.
- Edge case: no warnings gives no pin and no number gap. Warnings on two chains give two numbered notes in order. A warning on another metric gives none, as today.
- Error path: `verify-output` fails on a planted page with the warning only in a popover, and passes with it pinned.
- Happy path: a sample chain where velocity exceeds headline names it in the heading. With none, the heading says so.
- Edge case: a null velocity shows the unknown text and no bar. All null gives no chart.
- Edge case: velocity at zero and a scale whose largest value is zero don't divide by zero.
- Happy path: each `leading_for` value maps to its row's marker. An unknown value fails a test, as today. A tie marks both chains.
- Happy path: bars print no share that isn't in the dataset. Minted and lending show amounts only.
- Edge case: differing `as_of_day` values show the as-of row, and equal ones don't.
- Happy path: the words "trading" outside the note, and "settlement", don't appear as findings.
- Happy path: the selected chain's row and column highlight under each filter option, and contrast doesn't change.

**Verification:** `## Evidence` at 320, 390 and 1440 on the sample, and real data at 1440 with Ethereum's pin. The grid doesn't scroll sideways at 320.

**As built, where it differs from the above:**

- **Neither card is filtered, so neither has panels.** Each is one card in the static HTML, and CSS marks the chosen chain by weight and a rule, as [Cards and the filter](#cards-and-the-filter) says. Without `:has()` nothing is marked and nothing is lost.
- **The two cards share the Chains section,** `#chain-roles-view`, with velocity first. Velocity left the activity section.
- **Short forms in view:** `VELOCITY_PIN` for the denominators, and each warning's `pin` from `velocityWarnings`, which keeps the chain, date, both figures, the direction and "shouldn't be read as a trend". The full forms and the jumpy note are in the velocity card's popover.
- **"Wallets, not people" for the velocity card's wallet counts** is in the caption of its table, under the toggle, as those counts no longer show in view. `verify-output` checks that caption, and the essential list keeps the in-view instance beside the supply card's wallet figure.
- **Grid bars scale to the amount a lead is measured on** (`publish.py`'s `_LEADING_MEASURES`), so the longest bar and the lead marker can't disagree. Text is the dataset's: share of supply as a share, the others as an amount with the chain's own share where the dataset has one.
- **The grid stacks below a card content width of 380 px,** not the hairline table's 720, as five narrow columns fit a half-width card and the stacked form is four times as long. The notes of a card whose plot is a table go under it, at full width.
- **`ChartCard` has no `note` now.** `TableCard` keeps it for the methodology page.

---

- [ ] <a id="u6-acceptance"></a>**Unit U6: Acceptance**

**Goal:** prove the whole page by script, and fix what that finds.

**Dependencies:** U1 to U5. For real-data checks, a published dataset that passed every check. Read only a copy of `data/published/latest`, never `data/ousd.duckdb` or `.env`.

**Suggested worker:** an engineer who didn't build U1 to U5, as in Phase 3 an independent rebuild caught what the builder missed. High effort.

**Files**
- Create: `web/scripts/compare-numbers.mjs`, `web/scripts/compare-reach.mjs`
- Modify: fixes anywhere under `web/`, `web/scripts/acceptance.mjs`, `docs/build-log.md`, `docs/implementation-plan.md`, `docs/plans/2026-11-04-002-dashboard-refurbish-plan.md`, `README.md` if what it says about the site has moved
- Test: `web/tests/compare-numbers.test.ts`, and added to the owning unit's test file when a fix needs a regression test

**Approach**

**Number checks are by script, and only by script.** An earlier acceptance report held invented numbers marked as matching. So no report may state a number by hand: `## Evidence` pastes the scripts' output.

`compare-numbers.mjs`, committed this time:

- Opens the built page in Chromium. For each filter option, reads what's on screen and what's under every toggle and popover.
- Reads the dataset's JSON directly, with its own small `BigInt` arithmetic and parsing. It imports nothing from `web/lib/`, so a bug in the page's code can't hide in the check.
- Compact amounts match within half of the last shown digit of the exact figure, exact amounts to the base unit, and percentages as floors of basis points, as in Phase 3.
- Prints match, mismatch and observed-only counts. It exits non-zero on any mismatch, and also if fewer values were compared than a floor set per filter option, so a selector that finds nothing can't pass.

**Tamper control,** run each time and reported with the result. It alters values in a copy of the dataset and, separately, in a copy of the built page. Every altered value must be caught, and the control itself fails if any isn't. It covers at least a KPI, a segment under one chain, a waterfall step, a velocity bar and a grid cell.

`compare-reach.mjs` takes the build of the commit before U1 and the final build, both from the same dataset. Every number and sentence in the old page's full text must be in the new page's DOM, with every panel open and every filter option. Allowed differences are a short committed list, each naming its replacement, from [Where the words go](#where-the-words-go).

**In a real browser, at 320, 390, 768, 1056 and 1440:**

| Check | Pass means |
|---|---|
| Numbers on the real dataset | `compare-numbers.mjs` has 0 mismatches, above its floor, and the tamper control catches every altered value |
| Reach | `compare-reach.mjs` passes on the real dataset |
| Budget, `measure-page.mjs` | Within the pass lines, reported beside the targets. A miss is a finding for the maintainer, not cut caveats |
| Sample and preview builds | Frame on every page, every panel and the findings row. One card cropped alone reads as not real, and names its chain |
| Partial | "All covered", only the chains present, no "all chains", and `verdict.text` visible |
| Refused dataset | Build exits non-zero with the file and field named. Release mode refuses sample and preview |
| Real dataset, `make web-release` | Builds and renders, with the live trust status. Reported as blocked, not passed, if no such dataset exists |
| Stale, fake clock and a marked copy | Both swap in place with no layout shift. Data stays. Trust status changes. Each filter option keeps its data |
| Axe | No serious or critical violations, contrast included, across every state and width, for each filter option, **with every popover and toggle open**, as axe skips closed content |
| Layout | No horizontal page scroll at any width, in any filter state, with every toggle open. Independence line visible at every scroll position |
| Touch targets | Every trigger, filter option and standalone link at least 24 px. Counted by script, and 0 under |
| Layers | An open popover's box intersects no plot, value or note. Every essential caveat in [the list](#explanation-layers) is visible with nothing opened |
| JavaScript off | Headline, as-of, KPI values, findings, markers, pins, source and definition all visible in plain text. Filter and toggles work. The step line says it needs JavaScript and points to the table. An aged build's trust status still reads as dated |
| Keyboard | Full use with visible focus and the skip link. Arrow keys in the filter. Enter and Space on popovers and toggles. Escape closes. Charts and pins aren't in the tab order |
| Reduced motion | No animation or transition |
| No third-party requests | A request log shows only our own host, through every filter option and panel |
| Other browsers | One pass of filter, popover and toggle in Firefox and WebKit, after an explicit local browser download |
| Design system | Tokens, type, hairlines, no shadows, no pie charts or gradients, heading as a finding of about 12 words |

**Test scenarios:** the table above is the scenario list. `web/tests/compare-numbers.test.ts` proves the script itself: a planted mismatch, a tampered value at each kind of format, and a page with nothing to compare all fail. Any fix adds a regression test in the owning unit's test file.

**Docs:** a build log entry for what went wrong and the measured results, this plan's units ticked, and the implementation plan's status updated.

**Verification:** `## Evidence` has every state at every width, with script output pasted and refusals as text. **No deployment.**

## Maintainer review

<a id="maintainer-review"></a>After U5 the maintainer reviewed the whole page on real data (dataset 20261105T053217Z) and decided the changes below. They replace what this plan says elsewhere where the two differ, and `docs/design-system.md` is updated to match. Measured by `measure-page.mjs` on that dataset.

| Measure | Before the review | After | Target | Pass line |
|---|---|---|---|---|
| Words in `main`, at 1440 | 739 | 508 | About 450 | 510 |
| Words in `main`, at 390 | 739 | 506 | About 450 | 510 |
| Height at 1440 | 2,906 px | 3,266 px | | Under 3,338 px |
| Height at 390 | 7,072 px | 6,235 px | | Under 6,429 px |

Height at 1440 went up, as the half-width tiles are now full-width rows, and stays under its line.

| # | Decision | As built |
|---|---|---|
| 1 | Explanations are tooltips that float over the page and never push content down | One shared component, `web/components/tooltip.tsx`, replaces every push-down `<details>`: info popovers, "How we read this", the reconciliation detail and the legend's explanations. It opens on hover and keyboard focus, toggles on tap, closes on Escape and when focus or the pointer leaves, and the enhancer keeps it inside the viewport. A panel with a link is a disclosure with `aria-expanded`, and a plain one is `role="tooltip"` with `aria-describedby`. With no script, CSS opens it on `:hover` and `:focus-within`, and the `<noscript>` notes stay. The essential caveats in `web/lib/takeaways/caveats.ts` stay visible as pinned notes, shorter, with the note in full as a tooltip on their words. Data toggles stay `<details>`, as they swap a chart for its table and aren't explanations |
| 2 | Remove the F, I and E markers, the marker legend and the default "Our reading" tag | `status-chip.tsx` and `marker-legend.tsx` are gone, and so is the `marker` field in the segment config. On sample or preview data the verdict still says "Sample, not a finding." or "Preview, not a finding." beside the headline, in plain text |
| 3 | "How we read this" stays, as a tooltip, and the subtitle asks the page's question | "How we read this" is a tooltip beside the headline, holding the verdict's groups, `verdict.text` on real four-chain data, and the methodology link. The subtitle now reads "Is Open USD (OUSD) supply turning into money that moves?", in the review's own words, 6 fewer than before |
| 4 | A slimmer header: no independence line or methodology link in it | The header is the mark and the name, at `--header-height` 48px. The independence line and the methodology link are in the footer of every page, in view with nothing opened. `verify-output` checks the footer's line and drops the header's |
| 5 | Reconciliation in the footer, its detail on its own page | On a build that passed, the footer shows a green tick and "Reconciled", linked to `/reconciliation/`, with the dated sentence as its tooltip. `/reconciliation/` holds the former disclosure's words, table and checks, with "Back to the dashboard" and the normal header. On a stale, failed, preview or sample build the trust row stays at the top as before, linking to the page, and the footer says "Last reconciled …" or "Not reconciled", never "Reconciled". If a passing page goes stale in the reader's browser, the footer swaps in place and the as-of line at the top adds when supply was last reconciled, so nothing shifts |
| 6 | The first supply chart shows all chains together, as before U3 | One card, `#where-supply-sits`, with the sum's bar first and then one bar per chain, each with its name and total, and the legend, figures, notes and tables of the sum. The filter stays for the other cards, as it doesn't fight this: on the supply card it highlights the chosen chain's bar by weight and a rule, as on the velocity and chain cards, and hides nothing |
| 7 | The first chart's numbered notes become short labels, with their explanations in tooltips | "Placed can include unlabelled exchange custody.", "Exchange venues are a floor.", "Tempo: zero only because no exchange wallet is named." and "Wallets, not people.", each with its note in full as a tooltip. The same pattern shortens the step line's, the velocity chart's and the waterfall's notes |
| 8 | Full-width charts | The two-column grid from 1056 is gone. Every card spans the content width, one per row, and from a card of 860 its notes take a column beside the chart. The velocity chart sets its chains two to a row there, and the card's toggle and as-of line share a row |
| 9 | Fewer words | See the table above. Beyond items 1 to 8: the findings row is gone, as each finding is its card's heading and stays in view there; the velocity legend is gone, as each bar names its measure; the series legend names its lines and leaves their newest figures to the supply card and the table; card as-of lines show a clock and the date, with "As of" for assistive tech; weekly bars drop the year, which the as-of line has. No number changed and no finding is hidden |

**Decisions made in building it,** for the maintainer to confirm:

- **The findings row is removed.** U2 added it at the maintainer's request, but it repeats the four card headings word for word, 39 words and about 450 px at 390. Without the cut the page stays above the pass line. Undoing it is one component and its checks.
- **The PRD's "separate fact, estimate and opinion visibly"** now rests on words rather than markers: "How we read this" beside the headline, `verdict.text` with its estimate in view off real four-chain data, the verdict's groups titled by kind, and the methodology page. The PRD isn't changed here.
- **"Reconciled" carries no date in view.** The review asked for the tick and the word, with the dated sentence in the tooltip. With a script, a page that ages past 36 hours swaps it for "Last reconciled …". A copy kept with no script, such as an archive, keeps the green word at any age, though its as-of line at the top is dated. Putting the date beside the word would close this, at a few words' cost.
- **Without a script a tooltip can't be measured,** so at 390 a panel can run past the edge of the screen. Its content is still reached by focus and hover.
- **The word target isn't met.** 508 words against about 450, inside the pass line of 510. The next cuts, each with a cost: drop the per-chain direct labels on the supply bars (8 words, the per-chain placed share leaves the view), the KPI row's chain list on four-chain data (5, partial data still needs it), and everyday velocity from the chart (8, the PRD asks for all three velocities).

**Checks added to `verify-output`,** each proved by planting its fault: an explanation in a push-down `<details>` on the main page; a tooltip whose trigger isn't a native, named button or link, or whose panel doesn't follow it, or a linked panel that isn't a disclosure; the footer's independence line and methodology link; "Reconciled" in the footer on a build that didn't pass; and `/reconciliation/`, with its detail, its state and its link back to `/`. The marker checks are replaced by one that fails if a marker returns.

### Second round

The maintainer reviewed the build on localhost and decided these, which replace the first round where they differ.

| # | Decision | As built |
|---|---|---|
| 1 | No subtitle question, and clear space under the header | The question line is gone, and the headline sits clear of the header. `verify-output` fails if it returns |
| 2 | Methodology in the top bar, at the far right | In the header and the footer, both checked on every page |
| 3 | A way back from the methodology and reconciliation pages | "Back to the dashboard", to `/`, near the top of each, and the site's name in the header links home. Checked on every page but the dashboard |
| 4 | One clean "On this page" list | The top-level sections in order, with the Definitions items indented under it in compact columns that read down, not a three-column grid of mixed levels |
| 5 | Notes as numbered badges only | Every card's notes are numbered badges at the right of its last row, beside Table and the as-of date, and each opens its words, then the note in full, in the shared tooltip. No pin is left in a chart, a legend or the grid's caption, so each card has one set of markers, and the chart and legend take the freed width. This supersedes the rule that essential caveats stay visible as text: `verify-output` and the browser checks now require each essential caveat's badge in view and its words in that badge's tooltip |
| 6 | The exchange-linked legend row like every other | Swatch, "Exchange-linked, inside placed" in the normal text colour, and "$177.5M 19.38%" in the value column |
| 7 | A two-column footer | Information on the left, actions on the right, each level with its line, stacked in that order at 390 |
| 8 | Sticky header and filter stay on top | Each card is its own stacking context, so a bar's label can no longer draw over them while scrolling. A card with an open tooltip rises only above the cards after it |

After this round, by `measure-page.mjs` on the same dataset: 359 words at 1440 and 353 at 390, under the ~450 target, and 3,142 px at 1440 and 5,310 px at 390.

**Decided in building it:** pins inside charts (the waterfall's rows, the velocity chart's chains, the weekly bars' corner) went with the legend's, as the review asked for one set of markers per card. A note names its row or chain in words. The footer's status swaps outright rather than keeping the hidden text's space, as nothing follows it.

### Third round

The maintainer's third review, UI only. It replaces the first two rounds where they differ.

| # | Decision | As built |
|---|---|---|
| 1 | "How we read this" as an icon | A "?" button named "How we read this" after the headline's last word, opening the reading in the shared tooltip on hover, focus or tap. At the 320 px reflow width it may take a line of its own |
| 2 | Every tooltip consistent | One width (20rem, or the viewport less 2rem), padding, type size and line height. Every part of a panel is a paragraph with 0.5rem between them; a note's short words lead in bold and the note in full follows |
| 3 | No "Across Tempo, Ethereum, Base, Solana." under the KPIs | The line under the row now says only what differs: the chains when one is missing, and the date when it isn't the page's. With nothing to add, there's no line |
| 4 | Only "Data from {time} UTC." under the headline | On real data that's only old, nothing else: no "Last reconciled" and no out-of-date sentence there, no trust row at the top, and no stale line above any page's title. Sample, preview and a failed newer run keep their banner, trust row and stale note, unchanged |
| 5 | A compact footer status | Passing: a green tick and "Reconciled". Old: an amber clock (`--meaning-caution`, 5.3:1) and "Last reconciled 5 Nov". The full sentence is the tooltip and both link to `/reconciliation/`. `verify-output` and the browser checks require the clock state, never "Reconciled", on old data, and the tick on a passing build. This supersedes the rule that state text never moves into a tooltip, for real data that's only old |
| 6 | A concise `/reconciliation/` | Back arrow, title, then one status line ("Last run {time} UTC: every check passed.", with the stale or failed version), one sentence on what a run covers and doesn't check, the table under a short caption, and the checks as a two-column list of check and result |
| 7 | An arrow back, and the title at the top | On `/methodology/` and `/reconciliation/`, an arrow link named "Back to the dashboard" above the title, both titles in the large page-title style, at the top under the header |
| 8 | Card notes as footnotes (replacing the round's first item 8, badges by what they qualify) | A quiet superscript number in the body text's style by what each note qualifies: a whole-card note on the title, the rest on their legend row (placed, exchange venues), waterfall row (headline volume, issuer flows, clean large) or chain name (velocity). No tooltip. Numbers run in reading order within the card. A "Footnotes" toggle, a `<details>` at the right of the card's last row beside Table and the as-of date, closed by default, opens the numbered list below the card's content, by keyboard and with JavaScript off; a marker links to its footnote and opens the list. This replaces the round-two badge cluster, so each card has one set of markers and one list. It's the maintainer's choice, and supersedes the rule that essential caveats stay visible: `verify-output` and the browser checks require each essential caveat's marker in its card and its full text in that card's list, marker numbers that match the list, and the list closed at first and reachable by keyboard and with JavaScript off |

After this round, by `measure-page.mjs` on the same dataset, footnotes closed: 345 words at 1440 and 339 at 390, and 3,165 px at 1440 and 5,284 px at 390, with 57,410 bytes gzipped.

**Decided in building it:**
- **The waterfall and velocity charts are now read by screen readers**, as lists, since a marker is a link and can't sit inside a graphic hidden from them. Their tables still have the same figures.
- **Real data that was already old when built is treated like a passing page the reader's clock finds old.** It has the same clock state and nothing at the top, as the review moved only staleness. A failed newer run still counts as a failed check and keeps its trust row.
- **Where the browser can style a details element's content** (`::details-content`), the toggle keeps its place on the last row and the list takes the full width below. A browser that can't puts the open list on a row of its own with the toggle at its right.

### Fourth round

Two bugs from the maintainer, UI only.

| # | Decision | As built |
|---|---|---|
| 1 | The first supply card follows the chain filter | Choosing a chain left the card's heading, legend, figures and table at every chain's values. Each option now has its own supply card, as the other filtered cards do, so it works with JavaScript off. A chain's card has that chain's heading ("71.78% of Base supply stayed 14+ days in $1M-plus wallets."), legend, exchange-linked line, circulating, clean volume, active wallets, footnotes and tables, all from the dataset's per-chain fields as written. Every card keeps every chain's bar, the chosen one marked and the others muted, which was clearer than one bar alone: the bars still compare chains, and nothing moves when the filter changes. "All" is the card as it was. Named exchanges on a chain's card are that chain's holdings from `exchange_holdings`; a name from a listing, or one holding nothing, has no chain, so a chain's card says those "aren't split by chain" and leaves them to All. `verify-output` holds each panel's legend and table to the dataset's own rows, not the page's supply code, and refuses by name a chain's panel that shows every chain's figures |
| 2 | Footnotes open like a drawer, and a marker doesn't jump the page | With a script, the "Footnotes" toggle and a marker open and close the list by animating its height with a light fade, 220 ms, ease-out, and at once under `prefers-reduced-motion`. A marker cancels the browser's jump to its anchor and leaves the address alone, opens the list where the page is, and scrolls only if the list would end below the viewport, by the least that brings its bottom into view, never aligning it to the top. Focus then moves to the footnote (`preventScroll`) and it lights briefly. Without a script the details element and the marker links work as before, jump included. A browser check clicks a marker on a card in view and requires the page not to move when the list fits, the least scroll when it doesn't, the list's bottom inside the viewport, the address unchanged and focus on the footnote |

After this round, by `measure-page.mjs` on the same dataset, filter on All and footnotes closed: 345 words at 1440 and 339 at 390, and 3,165 px at 1440 and 5,284 px at 390, as before, with 65,724 bytes gzipped, up from 57,410 for the four chain copies of the supply card.

The other cards were checked for the same bug in the browser under each option. The step line, waterfall and weekly cards already showed each option's own panel. The velocity chart and the chain grid compare chains, so each figure carries its chain's name and the chosen chain is highlighted; they were left as they are.

## Maintainer actions

| When | Action |
|---|---|
| After U5 | The [whole-page review](#u2-first-screen), on real data on localhost |
| After the exchange research | Final headline wording, under [the open item](#headline-wording-open) |
| After U6 | Confirm the page is what the Phase 4 review should read |

## Risks

| Risk | Response |
|---|---|
| A caveat slips into a popover during a later edit | `verify-output` fails the build for the listed caveats, from U2 on |
| A pin goes false as data changes | Pins come from the manifest or a config condition. No chain name is hard-coded, and U5 tests a moved warning |
| Five panels make the page heavy | U3 measures it, against a pass line of 150,000 gzipped bytes. If it's over, U3 says so and proposes what to trim before U4 starts |
| Filtered panels make the number check miss states | `compare-numbers.mjs` walks each filter option and has a floor per option |
| A push-down popover feels jumpy on hover | The maintainer judges this at the whole-page review after U5. Floating is one CSS block, though it would then cover data |
| The word target is missed | Expected, at about 501. The cuts and their costs are [above](#word-and-height-budget), and limits win |
| A test-only fixture drifts from a later schema | The fixture works on the dataset's own rows in memory, so a schema change reaches it through the types |
| A reader on a filtered panel clicks a finding | The link resets the filter with JavaScript. Without it, the link can land on a hidden card, which [U3](#u3-supply-views) must make safe when it mounts the filter |
| `verdict.text` hidden on a state where it matters | `verdictTextVisible` is tested per state, and defaults to visible |

## Deferred

- **To implementation:** the exact CSS for the segmented control; exact bar sizes; which x ticks the step line keeps; hover delays.
- **To the maintainer:** the headline wording; further word cuts.
- **To later work:** other manifest warnings (`total_supply`, `placed_supply`, `clean_everyday_7d`) aren't shown today, and showing them as pins would be new text. Remembering the filter in the URL. The live small-ticket line and CSV downloads stay where the 001 plan put them.

## Done when

- `make check` is green in CI.
- Every check in U6 passes, or is reported as blocked or not run, with script output in `## Evidence`.
- The page keeps every finding visible, and everything else in reach, as `compare-reach.mjs` shows.
- Every chart has its takeaway, source, as-of time and definition link, enforced by types and `verify-output`.
- The maintainer has reviewed the whole page, and final headline wording is either settled or still open by choice.
- Nothing has been deployed.
