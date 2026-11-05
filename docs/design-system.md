# Design system

**Status:** Draft.
**Direction:** follows the look of Open Standard's site ([joinopenstandard.com](https://joinopenstandard.com/)), read from its CSS and homepage on 2026-11-03. Layout patterns for data also draw on [ousd.fyi](https://ousd.fyi/).
**In progress:** this file now describes the dashboard. The site reaches it through `docs/plans/2026-11-04-002-dashboard-refurbish-plan.md`, so until that plan's U6 merges, the site's layout, card and marker differ from what's written here. The palette and type don't change.

## Three limits

The project is independent, so it should feel related without appearing official.

1. **Don't use their logo, wordmark or globe artwork.** Use our own simple mark.
2. **Don't use their font.** Season is a licensed typeface. Use the substitutes below.
3. **Always show "Independent. Not affiliated with Open Standard or Bridge."** in the header and footer, not only in fine print.

## Principles

- **Calm, dense and data-first.** A reader gets the answer, the numbers and the charts before any prose. Dense means little wasted space and few words, not small text or crowded marks. Calm means one color family, no hype and no decoration.
- **The takeaway comes first.** Every chart's title is a finding of about 12 words at most, stating what the data shows.
- **Findings stay visible, and explanations appear on demand.** Move words rather than delete them. See [Explanation layers](#explanation-layers).
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
| `--text-small` | `0.875rem` | Table rows, chart labels, popover text |
| `--text-meta` | `0.75rem` | Sources and as-of times |

## Layout

Taken from their tokens:

| Token | Value |
|---|---|
| `--page-max-width` | `1440px` for the frame, and the card grid's width |
| `--page-content-width` | `1056px` for narrative |
| `--page-margin` | `clamp(1rem, 4.5vw, 4rem)` |
| `--section-space` | `clamp(3.5rem, 4.1vw + 2.5rem, 6.25rem)` |
| `--header-height` | `60px` on desktop. On phones it is a minimum, since the header wraps |
| `--header-budget` | `88px`, the most the header may take at 390 wide. Also the phone `scroll-padding-top`, so anchors aren't covered |
| `--grid-gap` | `1rem`, between cards in the grid |
| `--dashboard-space` | `clamp(1.5rem, 2vw, 2rem)`, between the dashboard's sections, in place of `--section-space` on the main page |
| `--filter-height` | `2.75rem`, the chain filter's height, which `scroll-padding-top` adds from 768 while it's sticky |
| `--pin-size` | `1.25rem`, a numbered pin |

**Named widths.** The first version of this file named 1440px and 1056px and no phone width. These are the widths the site is built and checked at. Two-column charts begin at 1056.

| Token | Value | Use |
|---|---|---|
| `--width-reflow` | `320px` | The WCAG reflow width. Nothing scrolls sideways |
| `--width-phone` | `390px` | The phone width screenshots and the header budget use |
| `--breakpoint-md` | `768px` | Tables stack below it |
| `--breakpoint-lg` | `1056px` | Two-column charts begin |
| `--breakpoint-xl` | `1440px` | The frame |

**Chart area.** A fixed height per breakpoint, reserved before the chart draws.

| Token | Value |
|---|---|
| `--chart-height-phone` | `240px` |
| `--chart-height-tablet` | `300px` |
| `--chart-height-desktop` | `340px` |

- **Header:** sticky at every width. At narrow widths the independence line wraps to a second row and is never hidden or truncated. It uses body color, not a subdued one.
- **Stacked tables:** rows stack as label and value pairs, and long exact amounts wrap anywhere, below 768 wide or in any card narrower than 720. This covers every table on the site, so none needs horizontal scroll.
- **Corners:** `--radius-control` is `4px` for buttons and chips, `--radius-input` is `6px` for inputs, and `--radius-card` is `12px` for chart cards.

| Token | Value |
|---|---|
| `--radius-control` | `4px` |
| `--radius-input` | `6px` |
| `--radius-card` | `12px` |

- **Shadows:** none.
- **Grid:** one scrolling page, with no tabs, because tabs hide findings. A responsive card grid: one column below 1056, two from 1056. A card with an open data toggle spans both columns.
- **Mobile first:** no horizontal page scroll. Wide tables become stacked rows.

## Components

| Component | Rules |
|---|---|
| **Header** | Our mark, "Open USD Monitor", the independence line, a methodology link. Stays compact and sticky |
| **Trust strip** | Slim row directly under the header, so the two read as one band: "Supply reconciled on all 4 chains as of {time} UTC", with a disclosure for details. It is dated and names what was reconciled, because "All 4 chains reconciled" implies inferred numbers are verified too and reads as current at any age. Must visibly change state if a check fails. Its state text never moves into a popover |
| **Verdict block** | A question line, then the headline on one line at `--text-headline`, its "Our reading" marker, an info popover, and the data-as-of time. It may wrap on a phone and is never truncated. `verdict.text` and the verdict's groups sit in the popover on real data across all four chains. On sample, preview or partial data `verdict.text` stays visible. The first thing anyone reads |
| **KPI row** | Three or four numbers split by hairlines, each with a label, a marker and an info popover holding its short note. No cards |
| **Findings row** | Four short cards, each a whole-card link to its chart, in `--text-card-title`. Each text is that chart's heading, from the same function, so the two can't disagree. On sample or preview data each card carries that word and the hatched edge |
| **Marker legend** | One line that says what each marker means, on the first screen, with a popover for the full meanings and a link to the methodology page |
| **Chain filter** | All, then each chain in the dataset. Native radios styled as a segmented control, with targets at least 36 px tall. Sticky from 768. On partial data the first option reads "All covered", never "All". It filters a view by showing that chain's own panel, and a view that compares chains highlights the selected one by weight and a rule, never opacity |
| **Chart card** | A finding as its title, marker, info popover, chart, pinned notes, data toggle, and a visible line with the as-of time and any Sample or Preview word. Takeaway, source, as-of time, definition, summary and table are required props, so a chart missing one doesn't compile. Source and definition sit in the popover and in a `<noscript>` note. The summary is visually hidden and read by assistive technology. A cropped card still shows its finding, scope, marker and as-of time. A legend sits beside its chart from a card of 560 wide and under it below that, and the notes then go under both |
| **Hairline table** | Rows split by `--color-border`, right-aligned tabular numbers, color squares for categories |
| **Marker** | F, I or E for Fact, Inferred and Estimate, and "Our reading" spelled out. Always visible, and used wherever a number or label isn't directly observed. "Our reading" marks an opinion, which the PRD requires to stay apart from fact. The letter and words carry the meaning, the outline style is only a second cue, and the full word is in the DOM for assistive technology |
| **Buttons** | Primary: maroon with off-white text. Secondary: 5% maroon with dark text. Both `4px` radius |
| **Accordion** | Plain row with a plus sign, for reconciliation detail and methods. Not for a chart's data, which uses the data toggle |
| **Footer** | Independence line, not financial advice, not an attestation, GitHub link |

## Explanation layers

Three layers, none covering data. Each is native HTML, and works by tap and keyboard. **Essential** means findings and any caveat needed to read a number correctly, such as Ethereum's velocity note. Essential text stays visible with nothing opened, so it never sits only in a popover or a tooltip.

| Layer | Opens by | May hold | May not hold | With JavaScript off |
|---|---|---|---|---|
| **Info popover** | Hover, tap or keyboard | Definition, source, as-of repeat, definition link, the long takeaway, the text summary, what a marker means | A finding, a caveat needed to read a number, a stale, sample, preview or partial message | Source and definition show as a plain note, and the popover still opens by tap and keyboard |
| **Pin and note** | Nothing: always visible | A short caveat, numbered to a mark on the chart, naming its chain or part in words. Beside the chart when the card is at least 560 wide, otherwise below it | A definition, a hard-coded chain name, or a figure that isn't in the dataset or already on the page | The same |
| **Data toggle** | Tap, click or keyboard | The chart's table in full, with exact amounts and any further tables. It swaps the chart for the table | The only copy of a finding or caveat | Works the same |

- **A popover pushes and doesn't float.** It opens in flow under the card's or cell's head, moving the plot down, so it covers nothing at any width. One is open at a time.
- **Popover behaviour:** a trigger at least 24 px with a name. Escape closes it, and returns focus when focus was in it or nowhere, so it never scrolls a reader away. With a mouse, moving onto the panel keeps it open, and a click keeps it open until dismissed. It has no animation.
- **Pins in a chart are decoration.** The graphic is hidden from assistive technology and out of the tab order, so a pin is never a link or a focusable element. Its note reads on its own without it. A plot that is real content, such as the chain grid's table, isn't a graphic and isn't hidden.
- **A pin comes from the data.** It appears because the manifest or a condition in the config says so, so it can't go false when the data changes.

## Charts

- **Line steps for supply**, because supply changes in discrete events. Avoid smoothing.
- **Horizontal stacked bars** for the supply journey, one bar at a time, with the chain filter choosing which. Segments, their legend and their notes come from one config, never per-segment markup. A segment has room for a coverage marker, for a labeled total that is a floor, and for optional per-entity rows. A floor prints in whole dollars, rounded down, so "at least" stays true of it.
- **Waterfall** for headline to clean volume.
- **Grouped horizontal bars** for velocity by chain, on a linear axis from zero. No broken axes or log scales.
- **A grid with in-cell bars** for what each chain does. A bar scales to its row's largest value and prints no new figure.
- **Direct labels first;** a legend when labels won't fit, listing every series even at zero, so it doesn't jump between filter options.
- **Dotted horizontal gridlines, no vertical ones.** Few ticks, with compact numbers like `$600M`.
- **Chart area:** shows a `--color-secondary` skeleton at its reserved height until the chart draws.
- **Dates in UTC** and labeled as such.
- **Tooltips add detail** but never hold anything essential, since touch devices may not show them. A tooltip may only repeat a value the table has.
- **No pie charts, 3D, gradients or animation** beyond a brief first load, which respects reduced motion.

## Voice

- Plain, specific and neutral. "Most supply hasn't moved since it was funded", not "OUSD is failing".
- Write "Open USD (OUSD)" on first use, because of the ticker clash with Origin Dollar.
- Prefer "wallet" to "user"; one person or company can hold many.
- Numbers carry units and dates. Round for reading, and keep exact values in tables and downloads.

## States

Every data view needs these:
- **Loading:** quiet skeleton in `--color-secondary`.
- **Sample or preview:** not real data. A banner says so on every page, and nothing on the page reads as a live figure. The word stays on every card's visible line and on the findings row.
- **Partial:** the filter lists only chains in the data, and headings name them. Never "all chains".
- **Stale:** visible note with the last good time. "Nothing newer has reached this page" when only the clock says it is old.
- **Check failed:** the trust strip changes, and the last good data stays up, labeled. "A newer run did not pass its checks" when the manifest says so.
- **Unknown:** "Not enough data yet", rather than a zero.

None of these states may move into a popover or a data toggle.

## Accessibility

- Body text at 4.5:1 contrast or better. Maroon on off-white comfortably passes.
- Never rely on color alone: label directly, or use pattern or a sign.
- Charts have a text summary and a data table alternative. The graphic itself is hidden from assistive technology and out of the tab order, since the summary and table carry the content.
- With JavaScript off, a chart that needs it says "This chart needs JavaScript. The Table button has the same data." The filter and data toggles still work, and sources and definitions show as plain notes.
- Full keyboard use, with visible focus states. The filter uses arrow keys, and popovers and toggles use Enter and Space.
- Targets at least 24 px, and the filter's at least 36 px.
- In forced colours the chosen filter option and an open popover's trigger use `Highlight`, as backgrounds drop out.
- Without `:has()`, every panel shows and the filter is hidden, because choosing an option couldn't change anything.
- Axe runs with every popover and toggle open, because it skips closed content.

## Tailwind

When the app is built, these tokens go in one CSS file as custom properties, mapped into Tailwind. No hardcoded colors in components. A missing token gets added here first, in the same change.
