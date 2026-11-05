# Design system

**Status:** Draft.
**Direction:** follows the look of Open Standard's site ([joinopenstandard.com](https://joinopenstandard.com/)), read from its CSS and homepage on 2026-11-03. Layout patterns for data also draw on [ousd.fyi](https://ousd.fyi/).
**In progress:** this file describes the dashboard, including the maintainer's whole-page review after U5 (see [the plan's Maintainer review](plans/2026-11-04-002-dashboard-refurbish-plan.md#maintainer-review)): explanations float as tooltips, there are no markers, every chart is full width, and the header is slim. The palette and type don't change.

## Three limits

The project is independent, so it should feel related without appearing official.

1. **Don't use their logo, wordmark or globe artwork.** Use our own simple mark.
2. **Don't use their font.** Season is a licensed typeface. Use the substitutes below.
3. **Always show "Independent. Not affiliated with Open Standard or Bridge."** in the footer of every page, in view with nothing opened, and never only in a tooltip. Since the maintainer's review it is no longer in the header.

## Principles

- **Calm, dense and data-first.** A reader gets the answer, the numbers and the charts before any prose. Dense means little wasted space and few words, not small text or crowded marks. Calm means one color family, no hype and no decoration.
- **The takeaway comes first.** Every chart's title is a finding of about 12 words at most, stating what the data shows.
- **Findings stay visible, and explanations appear on demand,** in tooltips that float over the page. Move words rather than delete them. See [Explanation layers](#explanation-layers).
- **Hairlines over boxes.** Use dividing lines and space; keep cards for charts and findings.
- **One color family.** Maroon carries the design, and a second hue appears only when it means something.
- **Show your work.** As-of times are always in view, and sources and definitions are one tap away.

## Color

These values come directly from their CSS.

| Token | Value | Use |
|---|---|---|
| `--color-maroon` | `#390922` | Primary, buttons, first data series |
| `--color-maroon-dark` | `#250013` | Body text, button hover, top banner |
| `--color-maroon-light` | `#E0D3CC` | Offset surfaces |
| `--color-off-white` | `#F3E9E3` | Page background, text on maroon |
| `--color-secondary` | maroon at 5% | Secondary buttons, quiet fills |
| `--color-secondary-strong` | maroon at 10% | Secondary hover |
| `--color-border` | `#3909222E` | Hairlines, about 18% maroon |
| `--color-subdued` | maroon and off-white, 50% mix in OKLCH | Secondary text on maroon |

**Text tokens.** Body text uses maroon-dark, and meta text (sources, as-of times) uses ramp step 2. Both are measured on `--color-off-white`, and a test computes them.

| Token | Value | Use | Contrast on off-white |
|---|---|---|---|
| `--color-body-text` | `#250013` | Body text, including the independence line | 14.2:1 for maroon, a little more for maroon-dark |
| `--color-meta-text` | `#7A4A62` | Sources, as-of times | 5.9:1 |
| `--color-banner-bg` | `#250013` | Top banner | |
| `--color-banner-text` | `#F3E9E3` | Text on the banner | Above 4.5:1 on the banner |

Their CSS also has `#FFAA68` (orange) and `#E500FF` (magenta). I didn't see them in the homepage's first screen, so don't use them until we need an accent.

**Surfaces, for this project:**

| Token | Value | Use |
|---|---|---|
| `--surface-card` | `#F7F2EE` | Chart cards, slightly lighter than the page. Sampled by eye from ousd.fyi, so check it |
| `--surface-inverse` | `#390922` | Occasional full-bleed panel |

### Data colors

**Sequential maroon ramp** for categories like chains, darkest for the largest:

| Token | Value | Example |
|---|---|---|
| `--ramp-1` | `#390922` | Tempo |
| `--ramp-2` | `#7A4A62` | Ethereum |
| `--ramp-3` | `#A97F92` | Base |
| `--ramp-4` | `#CDB3BC` | Solana |

**Outline rule.** Step 3 is 2.9:1 on off-white and step 4 is 1.6:1, so both fail the 3:1 limit for graphics and for text. Marks in those two steps get a maroon hairline outline and a direct label, and the steps are never used for text.

**Meaning colors**, needed for the supply journey and the activity waterfall:

| Token | Value | Meaning and note |
|---|---|---|
| `--meaning-active` | `#390922` | Active or clean. The story we're measuring |
| `--meaning-circulating` | `#7A4A62` | Circulating |
| `--meaning-idle` | `#CDB3BC` | Placed or idle. Deliberately quiet, with the outline rule |
| `--meaning-removed` | `#A97F92` | Removed from headline. Hatched: pattern as well as color, with the outline rule |
| `--meaning-positive` | `#2F6B4F` | Positive change, 5.3:1. Text with a sign, never color alone |
| `--meaning-negative` | `#A23B3B` | Negative change, 5.5:1. Text with a sign, never color alone |

## Typography

| Role | Their font | Ours | Treatment |
|---|---|---|---|
| Display and page headings | Season (serif cut) | **Newsreader** | Weight 500, tracking -0.02em, line height 1.05 |
| Section headings, UI, body | Season (sans cut) | **Inter** | Weights 450, 550 and 650, matching their medium-heavy feel |
| Numbers in tables and KPIs | | **Inter** with `tabular-nums` | Always tabular, so digits align |
| Addresses and hashes | System mono | `ui-monospace, SF Mono, Menlo` | Truncated, with a link to the explorer |

Both substitutes are free on Google Fonts, and the site serves them from the Fontsource packages. Newsreader is a judgment call, so compare it on a real page.

| Token | Value |
|---|---|
| `--font-display` | `"Newsreader Variable", Georgia, serif` |
| `--font-sans` | `"Inter Variable", system-ui, sans-serif` |
| `--font-mono` | `ui-monospace, "SF Mono", Menlo, monospace` |

| Token | Size | Use |
|---|---|---|
| `--text-display` | `clamp(2.5rem, 5vw, 4rem)` | The methodology page's title. The main page's headline uses the smaller size below |
| `--text-headline` | `clamp(1.5rem, 1.2rem + 1.2vw, 2.25rem)` | The main page's headline, one line at 1056 and up in its usual state |
| `--text-h2` | `clamp(1.5rem, 2.5vw, 2rem)` | Page section headings on the methodology page. Card titles use the smaller size below |
| `--text-card-title` | `1.125rem` | Card titles and findings |
| `--text-kpi` | `clamp(1.75rem, 3vw, 2.25rem)` | Key numbers |
| `--text-body` | `clamp(1rem, 0.95rem + 0.25vw, 1.125rem)` | Narrative, from `1rem` to `1.125rem` |
| `--text-small` | `0.875rem` | Table rows, chart labels, tooltip text |
| `--text-meta` | `0.75rem` | Sources and as-of times |

## Layout

Taken from their tokens:

| Token | Value |
|---|---|
| `--page-max-width` | `1440px` for the frame, and the card grid's width |
| `--page-content-width` | `1056px` for narrative |
| `--page-margin` | `clamp(1rem, 4.5vw, 4rem)` |
| `--section-space` | `clamp(3.5rem, 4.1vw + 2.5rem, 6.25rem)` |
| `--header-height` | `48px`, one row of the mark and the name at every width |
| `--header-budget` | `48px`, the most the header may take at 390 wide. Also the phone `scroll-padding-top`, so anchors aren't covered |
| `--grid-gap` | `1rem`, between cards in the grid |
| `--dashboard-space` | `clamp(1.5rem, 2vw, 2rem)`, between the dashboard's sections, in place of `--section-space` on the main page |
| `--filter-height` | `2.75rem`, the chain filter's height, which `scroll-padding-top` adds from 768 while it's sticky |
| `--pin-size` | `1.25rem`, a numbered pin |

**Named widths.** The first version of this file named 1440px and 1056px and no phone width. These are the widths the site is built and checked at. Every chart card is one to a row at every width.

| Token | Value | Use |
|---|---|---|
| `--width-reflow` | `320px` | The WCAG reflow width. Nothing scrolls sideways |
| `--width-phone` | `390px` | The phone width screenshots and the header budget use |
| `--breakpoint-md` | `768px` | Tables stack below it |
| `--breakpoint-lg` | `1056px` | The KPI row's four cells share a row, and the headline fits one line |
| `--breakpoint-xl` | `1440px` | The frame |

**Chart area.** A fixed height per breakpoint, reserved before the chart draws.

| Token | Value |
|---|---|
| `--chart-height-phone` | `240px` |
| `--chart-height-tablet` | `300px` |
| `--chart-height-desktop` | `340px` |

- **Header:** sticky at every width, one row of our mark and the site name. The independence line and the methodology link are in the footer.
- **Footer:** the independence line in body color, not a subdued one, then the reconciliation status, the methodology link, not financial advice, not an attestation, and the GitHub link.
- **Stacked tables:** rows stack as label and value pairs, and long exact amounts wrap anywhere, below 768 wide or in any card narrower than 720. This covers every table on the site, so none needs horizontal scroll.
- **Corners:** `--radius-control` is `4px` for buttons and chips, `--radius-input` is `6px` for inputs, and `--radius-card` is `12px` for chart cards.

| Token | Value |
|---|---|
| `--radius-control` | `4px` |
| `--radius-input` | `6px` |
| `--radius-card` | `12px` |

- **Shadows:** none.
- **Grid:** one scrolling page, with no tabs, because tabs hide findings. One card to a row at every width, each spanning the content width. A card from 860 wide puts its notes in a column beside its chart and legend, rather than under them.
- **Mobile first:** no horizontal page scroll. Wide tables become stacked rows.

## Components

| Component | Rules |
|---|---|
| **Header** | Our mark and "Open USD Monitor". Stays one row and sticky |
| **Reconciliation status** | On a build that passed, a green tick and the word "Reconciled" in the footer, linking to `/reconciliation/`, with the dated sentence "Supply reconciled on all 4 chains as of {time} UTC" as its tooltip on hover and focus. The word is there with the tick, so it isn't colour alone, and `--meaning-positive` meets 4.5:1. On any other build (stale, a failed newer run, preview or sample) the trust row stays at the top of the main page with its dated state, as before, and the footer says "Last reconciled …" or "Not reconciled", never "Reconciled". If the reader's clock finds a passing page old, the footer's word swaps in place and the as-of line at the top says when supply was last reconciled. State text never moves into a tooltip |
| **Reconciliation page** | `/reconciliation/`: the trust row's former detail, its table, the checks list and what it doesn't verify, with "Back to the dashboard" and the normal header |
| **Verdict block** | A question line, then the headline on one line at `--text-headline`, "How we read this" as a tooltip, and the data-as-of time. It may wrap on a phone and is never truncated. `verdict.text` and the verdict's groups sit in the tooltip on real data across all four chains. On sample, preview or partial data `verdict.text` stays visible, and the words "Sample, not a finding." or "Preview, not a finding." sit beside the headline in plain text. The first thing anyone reads |
| **KPI row** | Four numbers split by hairlines, each with a label and an info tooltip holding its short note. No cards and no markers |
| **Findings** | No separate row. Each chart's heading is its finding, in view on its card. The review's word target left no room for the same four sentences twice |
| **Chain filter** | All, then each chain in the dataset. Native radios styled as a segmented control, with targets at least 36 px tall. Sticky from 768. On partial data the first option reads "All covered", never "All". It filters a view by showing that chain's own panel, and a view that compares chains highlights the selected one by weight and a rule, never opacity |
| **Chart card** | A finding as its title, an info tooltip, chart, pinned notes, then the data toggle and a line with a clock, the as-of time and any Sample or Preview word, which share the last row. Takeaway, source, as-of time, definition, summary and table are required props, so a chart missing one doesn't compile. Source and definition sit in the tooltip and in a `<noscript>` note. The summary is visually hidden and read by assistive technology. A cropped card still shows its finding, scope and as-of time. A legend sits beside its chart from a card of 560 wide and under it below that. The notes go under both, or beside them from 860 |
| **Hairline table** | Rows split by `--color-border`, right-aligned tabular numbers, color squares for categories |
| **Tooltip** | One shared component for every explanation (see [Explanation layers](#explanation-layers)). An "i" button with a name on a card's or a KPI's head, dotted-underlined words on a note or "How we read this", or a link such as the footer's "Reconciled" |
| **Buttons** | Primary: maroon with off-white text. Secondary: 5% maroon with dark text. Both `4px` radius |
| **Footer** | Independence line, reconciliation status, methodology link, not financial advice, not an attestation, GitHub link |

**No markers.** The maintainer's review removed the F, I and E markers and the "Our reading" tag: most of the page is inferred, and readers understand that. The methodology page still says which figures are read from the chain and which rest on rules or assumptions. The one exception is a guard that frames the verdict: on sample or preview data the headline says "Sample, not a finding." or "Preview, not a finding." in plain text.

## Explanation layers

Three layers. **Essential** means findings and any caveat needed to read a number correctly, such as Ethereum's velocity note, "Wallets, not people", hops counted more than once, and "everyday means under $1M". Essential text stays visible with nothing opened, so it never sits only in a tooltip.

| Layer | Opens by | May hold | May not hold | With JavaScript off |
|---|---|---|---|---|
| **Tooltip** | Hover, keyboard focus, or a tap on touch | Definition, source, as-of repeat, definition link, the long takeaway, the text summary, a pinned note in full | A finding, the only copy of a caveat needed to read a number, a stale, sample, preview or partial message | CSS opens it on `:hover` and `:focus-within`, and Tab reaches its links. Source and definition also show as a plain note |
| **Pin and note** | Nothing: always visible | A short caveat, numbered to a mark on the chart, naming its chain or part in words, with the note in full as a tooltip on its words. Beside the chart when the card is at least 560 wide, otherwise below it | A definition, a hard-coded chain name, or a figure that isn't in the dataset or already on the page | The same |
| **Data toggle** | Tap, click or keyboard | The chart's table in full, with exact amounts and any further tables. It swaps the chart for the table | The only copy of a finding or caveat | Works the same |

- **A tooltip floats and moves nothing.** The maintainer's review ruled this way: an explanation never pushes the page down, so it may cover what's beside it while open. One is open at a time. A card with an open tooltip rises over the cards after it, and stays under the sticky header.
- **Tooltip behaviour:** a native button or link, at least 24 px when it stands alone, with a name. It opens on hover after a short delay and on keyboard focus, and a click or tap keeps it open until a second click, Escape, or focus or the pointer leaving. Escape closes it, and returns focus to the trigger only when focus was inside the panel, so it never scrolls a reader away. A panel with a link is a disclosure, with `aria-expanded`, and Tab moves into it. A panel of plain text is `role="tooltip"` and describes its trigger with `aria-describedby`. The enhancer keeps an open panel inside the viewport at every width, shifting it sideways and flipping it above its trigger when there's no room below. It has a maroon edge, which forced colours keep, a visible focus ring, and no animation. With no script the panel aligns to its trigger and can't be measured.
- **Pins in a chart are decoration.** The graphic is hidden from assistive technology and out of the tab order, so a pin is never a link or a focusable element. Its note reads on its own without it. A plot that is real content, such as the chain grid's table, isn't a graphic and isn't hidden.
- **A pin comes from the data.** It appears because the manifest or a condition in the config says so, so it can't go false when the data changes.

## Charts

- **Line steps for supply**, because supply changes in discrete events. Avoid smoothing.
- **Horizontal stacked bars** for the supply journey: every chain in one view, the sum first and then one bar per chain, as the page had it before the filter. The chain filter highlights a chain's bar by weight and a rule, and hides none. Segments, their legend and their notes come from one config, never per-segment markup. A segment has room for a coverage marker, for a labeled total that is a floor, and for optional per-entity rows. A floor prints in whole dollars, rounded down, so "at least" stays true of it.
- **Waterfall** for headline to clean volume.
- **Grouped horizontal bars** for velocity by chain, on a linear axis from zero. No broken axes or log scales.
- **A grid with in-cell bars** for what each chain does. A bar scales to its row's largest value and prints no new figure.
- **Direct labels first;** a legend when labels won't fit, listing every series even at zero, so it doesn't jump between filter options.
- **Dotted horizontal gridlines, no vertical ones.** Few ticks, with compact numbers like `$600M`.
- **Chart area:** shows a `--color-secondary` skeleton at its reserved height until the chart draws.
- **Dates in UTC** and labeled as such.
- **A chart's own tooltip,** such as the step line's, adds detail but never holds anything essential, since touch devices may not show it. It may only repeat a value the table has.
- **No pie charts, 3D, gradients or animation** beyond a brief first load, which respects reduced motion.

## Voice

- Plain, specific and neutral. "Most supply hasn't moved since it was funded", not "OUSD is failing".
- Write "Open USD (OUSD)" on first use, because of the ticker clash with Origin Dollar.
- Prefer "wallet" to "user"; one person or company can hold many.
- Numbers carry units and dates. Round for reading, and keep exact values in tables and downloads.

## States

Every data view needs these:
- **Loading:** quiet skeleton in `--color-secondary`.
- **Sample or preview:** not real data. A banner says so on every page, and nothing on the page reads as a live figure. The word stays on every card's visible line, and the verdict says "Sample, not a finding." or "Preview, not a finding." beside the headline.
- **Partial:** the filter lists only chains in the data, and headings name them. Never "all chains".
- **Stale:** visible note with the last good time. "Nothing newer has reached this page" when only the clock says it is old.
- **Check failed:** the trust row is at the top of the main page, and the last good data stays up, labeled. "A newer run did not pass its checks" when the manifest says so. The footer never says "Reconciled" then.
- **Unknown:** "Not enough data yet", rather than a zero.

None of these states may move into a tooltip or a data toggle.

## Accessibility

- Body text at 4.5:1 contrast or better. Maroon on off-white comfortably passes.
- Never rely on color alone: label directly, or use pattern or a sign.
- Charts have a text summary and a data table alternative. The graphic itself is hidden from assistive technology and out of the tab order, since the summary and table carry the content.
- With JavaScript off, a chart that needs it says "This chart needs JavaScript. The Table button has the same data." The filter and data toggles still work, and sources and definitions show as plain notes.
- Full keyboard use, with visible focus states. The filter uses arrow keys, a tooltip opens on focus and Enter or Space keeps or closes it, and toggles use Enter and Space.
- Targets at least 24 px, and the filter's at least 36 px.
- In forced colours the chosen filter option and an open tooltip's trigger use `Highlight`, as backgrounds drop out, and a tooltip keeps its edge.
- Without `:has()`, every panel shows and the filter is hidden, because choosing an option couldn't change anything.
- Axe runs with every tooltip and toggle open, because it skips closed content.

## Tailwind

When the app is built, these tokens go in one CSS file as custom properties, mapped into Tailwind. No hardcoded colors in components. A missing token gets added here first, in the same change.
