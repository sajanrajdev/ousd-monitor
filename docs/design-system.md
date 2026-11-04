# Design system

**Status:** Draft.
**Direction:** follows the look of Open Standard's site ([joinopenstandard.com](https://joinopenstandard.com/)), read from its CSS and homepage on 2026-11-03. Layout patterns for data also draw on [ousd.fyi](https://ousd.fyi/).

## Three limits

The project is independent, so it should feel related without appearing official.

1. **Don't use their logo, wordmark or globe artwork.** Use our own simple mark.
2. **Don't use their font.** Season is a licensed typeface. Use the substitutes below.
3. **Always show "Independent. Not affiliated with Open Standard or Bridge."** in the header and footer, not only in fine print.

## Principles

- **Calm and editorial.** It reads like a well-set financial report, not a crypto dashboard.
- **The takeaway comes first.** Every chart's title is a sentence that says what it shows.
- **Hairlines over boxes.** Use dividing lines and space; keep cards for charts.
- **One color family.** Maroon carries the design, and a second hue appears only when it means something.
- **Show your work.** Sources, as-of times and definitions are part of the design.

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
| `--text-display` | `clamp(2.5rem, 5vw, 4rem)` | The one-sentence answer |
| `--text-h2` | `clamp(1.5rem, 2.5vw, 2rem)` | View headings, written as takeaways |
| `--text-kpi` | `clamp(1.75rem, 3vw, 2.25rem)` | Key numbers |
| `--text-body` | `clamp(1rem, 0.95rem + 0.25vw, 1.125rem)` | Narrative, from `1rem` to `1.125rem` |
| `--text-small` | `0.875rem` | Table rows, chart labels |
| `--text-meta` | `0.75rem` | Sources and as-of times |

## Layout

Taken from their tokens:

| Token | Value |
|---|---|
| `--page-max-width` | `1440px` for the frame |
| `--page-content-width` | `1056px` for narrative and charts |
| `--page-margin` | `clamp(1rem, 4.5vw, 4rem)` |
| `--section-space` | `clamp(3.5rem, 4.1vw + 2.5rem, 6.25rem)` |
| `--header-height` | `60px` on desktop. On phones it is a minimum, since the header wraps |
| `--header-budget` | `88px`, the most the header may take at 390 wide. Also the phone `scroll-padding-top`, so anchors aren't covered |

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
- **Stacked tables:** below 768, rows stack as label and value pairs and long exact amounts wrap anywhere. This covers every table on the site, so none needs horizontal scroll.
- **Corners:** `--radius-control` is `4px` for buttons and chips, `--radius-input` is `6px` for inputs, and `--radius-card` is `12px` for chart cards.

| Token | Value |
|---|---|
| `--radius-control` | `4px` |
| `--radius-input` | `6px` |
| `--radius-card` | `12px` |

- **Shadows:** none.
- **Grid:** single reading column; charts may sit in two columns on desktop and always stack on mobile.
- **Mobile first:** no horizontal page scroll. Wide tables become stacked rows.

## Components

| Component | Rules |
|---|---|
| **Header** | Our mark, "Open USD Monitor", the independence line, a methodology link |
| **Verdict block** | A question line, then the display sentence, one supporting line, and data-as-of time. Its `opinions` show below the supporting line. The first thing anyone reads |
| **KPI row** | Three or four numbers split by hairlines, each with a label and a short note. No cards |
| **Trust strip** | Slim row: "Supply reconciled on all 4 chains as of {time} UTC", with a link to details. It is dated and names what was reconciled, because "All 4 chains reconciled" implies inferred numbers are verified too and reads as current at any age. Must visibly change state if a check fails |
| **Chart card** | Takeaway title, status chip, text summary, chart, the same data in a table inside an accordion, then a footer with source, as-of time and definition link. Source, time, definition, summary and table are required, so a chart missing one doesn't compile |
| **Hairline table** | Rows split by `--color-border`, right-aligned tabular numbers, color squares for categories |
| **Status chip** | Fact, Estimate, Inferred or Our reading. Used wherever a number or label isn't directly observed. "Our reading" marks an opinion, which the PRD requires to stay apart from fact. The label carries the meaning, and the outline style is only a second cue |
| **Buttons** | Primary: maroon with off-white text. Secondary: 5% maroon with dark text. Both `4px` radius |
| **Accordion** | Plain row with a plus sign, for sources and methods |
| **Footer** | Independence line, not financial advice, not an attestation, GitHub link |

## Charts

- **Line steps for supply**, because supply changes in discrete events. Avoid smoothing.
- **Horizontal stacked bars or a funnel** for the supply journey.
- **Waterfall** for headline to clean volume.
- **Direct labels first;** a legend only when labels won't fit.
- **Dotted horizontal gridlines, no vertical ones.** Few ticks, with compact numbers like `$600M`.
- **Chart area:** shows a `--color-secondary` skeleton at its reserved height until the chart draws.
- **Dates in UTC** and labeled as such.
- **Tooltips add detail** but never hold anything essential, since touch devices may not show them.
- **No pie charts, 3D, gradients or animation** beyond a brief first load, which respects reduced motion.

## Voice

- Plain, specific and neutral. "Most supply hasn't moved since it was funded", not "OUSD is failing".
- Write "Open USD (OUSD)" on first use, because of the ticker clash with Origin Dollar.
- Prefer "wallet" to "user"; one person or company can hold many.
- Numbers carry units and dates. Round for reading, and keep exact values in tables and downloads.

## States

Every data view needs these:
- **Loading:** quiet skeleton in `--color-secondary`.
- **Sample or preview:** not real data. A banner says so on every page, and nothing on the page reads as a live figure.
- **Stale:** visible note with the last good time. "Nothing newer has reached this page" when only the clock says it is old.
- **Check failed:** the trust strip changes, and the last good data stays up, labeled. "A newer run did not pass its checks" when the manifest says so.
- **Unknown:** "Not enough data yet", rather than a zero.

## Accessibility

- Body text at 4.5:1 contrast or better. Maroon on off-white comfortably passes.
- Never rely on color alone: label directly, or use pattern or a sign.
- Charts have a text summary and a data table alternative. The graphic itself is hidden from assistive technology and out of the tab order, since the summary and table carry the content.
- With JavaScript off, a chart area says "This chart needs JavaScript. The table below has the same data."

- Full keyboard use, with visible focus states.

## Tailwind

When the app is built, these tokens go in one CSS file as custom properties, mapped into Tailwind. No hardcoded colors in components. A missing token gets added here first, in the same change.
