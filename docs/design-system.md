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

Their CSS also has `#FFAA68` (orange) and `#E500FF` (magenta). I didn't see them in the homepage's first screen, so don't use them until we need an accent.

**Surfaces, for this project:**

| Token | Value | Use |
|---|---|---|
| `--surface-card` | `#F7F2EE` | Chart cards, slightly lighter than the page. Sampled by eye from ousd.fyi, so check it |
| `--surface-inverse` | `#390922` | Occasional full-bleed panel |

### Data colors

**Sequential maroon ramp** for categories like chains, darkest for the largest:

| Step | Value | Example |
|---|---|---|
| 1 | `#390922` | Tempo |
| 2 | `#7A4A62` | Ethereum |
| 3 | `#A97F92` | Base |
| 4 | `#CDB3BC` | Solana |

**Meaning colors**, needed for the supply journey and the activity waterfall:

| Meaning | Value | Note |
|---|---|---|
| Active or clean | `#390922` | The story we're measuring |
| Circulating | `#7A4A62` | |
| Placed or idle | `#CDB3BC` | Deliberately quiet |
| Removed from headline | Hatched `#A97F92` | Pattern as well as color |
| Positive change | `#2F6B4F` | Text with a sign, never color alone |
| Negative change | `#A23B3B` | Text with a sign, never color alone |

Check the ramp's contrast on the page background during build. Steps 3 and 4 will need direct labels, since they are too light for text.

## Typography

| Role | Their font | Ours | Treatment |
|---|---|---|---|
| Display and page headings | Season (serif cut) | **Newsreader** | Weight 500, tracking -0.02em, line height 1.05 |
| Section headings, UI, body | Season (sans cut) | **Inter** | Weights 450, 550 and 650, matching their medium-heavy feel |
| Numbers in tables and KPIs | | **Inter** with `tabular-nums` | Always tabular, so digits align |
| Addresses and hashes | System mono | `ui-monospace, SF Mono, Menlo` | Truncated, with a link to the explorer |

Both substitutes are free on Google Fonts. Newsreader is a judgment call, so compare it on a real page.

| Token | Size | Use |
|---|---|---|
| `--text-display` | `clamp(2.5rem, 5vw, 4rem)` | The one-sentence answer |
| `--text-h2` | `clamp(1.5rem, 2.5vw, 2rem)` | View headings, written as takeaways |
| `--text-kpi` | `clamp(1.75rem, 3vw, 2.25rem)` | Key numbers |
| `--text-body` | `1rem` to `1.125rem` | Narrative |
| `--text-small` | `0.875rem` | Table rows, chart labels |
| `--text-meta` | `0.75rem` | Sources and as-of times |

## Layout

Taken from their tokens:

| Token | Value |
|---|---|
| `--page-max-width` | `1440px` for the frame; narrative and charts at about `1056px` |
| `--page-margin` | `clamp(1rem, 4.5vw, 4rem)` |
| `--section-space` | `clamp(3.5rem, 4.1vw + 2.5rem, 6.25rem)` |
| `--header-height` | `60px` |

- **Corners:** `4px` for buttons and chips, `6px` for inputs, `12px` for chart cards.
- **Shadows:** none.
- **Grid:** single reading column; charts may sit in two columns on desktop and always stack on mobile.
- **Mobile first:** no horizontal page scroll. Wide tables become stacked rows.

## Components

| Component | Rules |
|---|---|
| **Header** | Our mark, "Open USD Monitor", the independence line, a methodology link |
| **Verdict block** | Display sentence, one supporting line, data-as-of time. The first thing anyone reads |
| **KPI row** | Three or four numbers split by hairlines, each with a label and a short note. No cards |
| **Trust strip** | Slim row: "All 4 chains reconciled", last check time, link to details. Must visibly change state if a check fails |
| **Chart card** | Takeaway title, chart, then a footer with source, as-of time and definition link |
| **Hairline table** | Rows split by `--color-border`, right-aligned tabular numbers, color squares for categories |
| **Status chip** | Fact, Estimate or Inferred. Used wherever a number or label isn't directly observed |
| **Buttons** | Primary: maroon with off-white text. Secondary: 5% maroon with dark text. Both `4px` radius |
| **Accordion** | Plain row with a plus sign, for sources and methods |
| **Footer** | Independence line, not financial advice, not an attestation, GitHub link |

## Charts

- **Line steps for supply**, because supply changes in discrete events. Avoid smoothing.
- **Horizontal stacked bars or a funnel** for the supply journey.
- **Waterfall** for headline to clean volume.
- **Direct labels first;** a legend only when labels won't fit.
- **Dotted horizontal gridlines, no vertical ones.** Few ticks, with compact numbers like `$600M`.
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
- **Stale:** visible note with the last good time.
- **Check failed:** the trust strip changes, and the last good data stays up, labeled.
- **Unknown:** "Not enough data yet", rather than a zero.

## Accessibility

- Body text at 4.5:1 contrast or better. Maroon on off-white comfortably passes.
- Never rely on color alone: label directly, or use pattern or a sign.
- Charts have a text summary and a data table alternative.
- Full keyboard use, with visible focus states.

## Tailwind

When the app is built, these tokens go in one CSS file as custom properties, mapped into Tailwind. No hardcoded colors in components. A missing token gets added here first, in the same change.
