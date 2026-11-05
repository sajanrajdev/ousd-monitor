// What verify-output wants on the main page's first screen, written by hand, so a test can plant one
// fault and nothing else. Used for pages that no real build wrote.
import { CARD_ANCHORS } from "@/lib/definitions";
import { JUMPY_NOTE, VELOCITY_NOTE } from "@/lib/takeaways/caveats";

type Verdict = { sentence: string; text: string; textVisible: boolean; items: string[] };
type Note = { kind: string; chain?: string; text: string };

export const PLANTED_VERDICT: Verdict = {
  sentence: "A headline.",
  text: "The verdict's text, 12% & more.",
  textVisible: true,
  items: ["A fact.", "An estimate."],
};

export const PLANTED_KPI_SCOPE = "Across Tempo.";
export const PLANTED_KPI_VALUES = ["$1", "$1", "$1", "$1"];

function escaped(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

// Ids for tooltip panels, unique on a planted page as React's are on a built one.
let nextTipId = 0;
const tipId = () => `tip-${(nextTipId += 1)}`;

// A tooltip as components/tooltip.tsx writes it. With a link in it, it's a disclosure. Its class
// comes before its id, so a test that slices a panel at the next `<div id="` isn't cut short.
export function plantedTip(
  trigger: string,
  panel: string,
  { interactive = /<a\s/.test(panel), icon = false, tag = "span" } = {},
): string {
  const id = tipId();
  const label = icon ? ` aria-label="${trigger}"` : "";
  const points = interactive
    ? `aria-expanded="false" aria-controls="${id}"`
    : `aria-describedby="${id}"`;
  const role = interactive ? "" : ' role="tooltip"';
  return `<${tag} class="tip" data-tip><button type="button" class="tip__trigger"${label} ${points}>${icon ? "" : trigger}</button><${tag} class="tip__panel" id="${id}"${role}>${panel}</${tag}></${tag}>`;
}

// An "i" button's tooltip, as a card's or a KPI's head has it.
export const plantedInfoTip = (label: string, panel: string) =>
  plantedTip(label, panel, { icon: true, interactive: true, tag: "div" });

export function plantedHeadline(verdict: Verdict = PLANTED_VERDICT): string {
  const text = `<span data-verdict-text>${escaped(verdict.text)}</span>`;
  const items = verdict.items.map((item) => `<span>${escaped(item)}</span>`).join("");
  return `<p data-section="question">A question?</p><div class="verdict-block__head"><h1>${escaped(verdict.sentence)}</h1>
    ${plantedTip(
      "How we read this",
      `${verdict.textVisible ? "" : text}${items}<a href="/methodology/#verdict">How the reading is made</a>`,
    )}</div>
    ${verdict.textVisible ? `<p>${text}</p>` : ""}`;
}

const kpiCell = (
  value: string,
) => `<div><dt>A label</dt><dd><span data-kpi-value>${value}</span></dd>
  <dd>${plantedInfoTip("About: A label", '<p data-kpi-note>A note.</p><a href="/methodology/#velocity">Definition</a>')}
  <noscript><p>A note. <a href="/methodology/#velocity">Definition</a></p></noscript></dd></div>`;

export function plantedKpis(
  scope: string = PLANTED_KPI_SCOPE,
  values: string[] = PLANTED_KPI_VALUES,
): string {
  return `<dl>${values.map(kpiCell).join("")}</dl><p>${scope}</p>`;
}

// The trust row's link to its own page, where the disclosure used to be.
export const PLANTED_TRUST_LINK = '<a href="/reconciliation/">Reconciliation detail</a>';

export const PLANTED_INDEPENDENCE = "Independent. Not affiliated with Open Standard or Bridge.";

// The footer's status as components/trust-strip.tsx writes it: "Reconciled" only when the build
// passed, with the dated sentence as its tooltip and the stale text beside it to swap to.
export function plantedFooterStatus(
  passing: boolean,
  trustLine: { fresh: string | null; stale: string },
): string {
  const stale = `<span>▲ <a href="/reconciliation/">${escaped(trustLine.stale)}</a></span>`;
  const fresh = passing
    ? `<span data-reconciled><span class="tip" data-tip><a href="/reconciliation/" class="tip__trigger" aria-describedby="footer-tip"><span aria-hidden="true">✓</span> Reconciled</a><span id="footer-tip" class="tip__panel" role="tooltip">${escaped(trustLine.fresh ?? "")}</span></span></span>`
    : "";
  return `<p data-footer-status><span class="freshness-text"><span class="freshness-text__fresh">${fresh}</span><span class="freshness-text__stale">${stale}</span></span></p>`;
}

export function plantedFooter(
  passing: boolean,
  trustLine: { fresh: string | null; stale: string },
  extra = "",
): string {
  return `<footer><p>${PLANTED_INDEPENDENCE}</p>${plantedFooterStatus(passing, trustLine)}
    <nav><a href="/methodology">Methodology</a></nav><p>Not financial advice.</p>${extra}</footer>`;
}

export const PLANTED_TRUST_CAVEAT = "It doesn't verify placed share or velocity.";

// The reconciliation page's main, as app/reconciliation/page.tsx writes it.
export function plantedReconciliationMain(stateLine: string): string {
  return `<main><p><a href="/">Back to the dashboard</a></p><h1>Reconciliation</h1>
    <section data-section="reconciliation"><p class="trust-strip__status">${escaped(stateLine)}</p>
    <p><a href="/methodology/#reconciliation">What this covers</a></p>
    <p>Reconciliation compares mints minus burns. ${PLANTED_TRUST_CAVEAT}</p>
    <table><tbody><tr><td>Tempo</td></tr></tbody></table></section></main>`;
}

// The page's serialized copy, as Next writes it into the page, with an id no other chunk has.
let nextFlightId = 0x1000;
export function plantedFlight(tree: unknown): string {
  nextFlightId += 1;
  const line = `${nextFlightId.toString(16)}:${JSON.stringify(tree)}\n`;
  return `<script>self.__next_f.push([1,${JSON.stringify(line).replaceAll("<", "\\u003c")}])</script>`;
}

const flightElement = (type: string, props: object) => ["$", type, null, props];

export function plantedNotes(notes: Note[]): string {
  const html = notes
    .map(
      ({ kind, chain, text }) =>
        `<p data-note="${kind}"${chain ? ` data-chain="${chain}"` : ""}>${text}</p>`,
    )
    .join("");
  return notes.length > 0 ? `${html}${plantedNotesFlight(notes)}` : html;
}

// The notes in the payload alone, for a test whose fault is in the HTML.
export function plantedNotesFlight(notes: Note[]): string {
  return plantedFlight(
    notes.map(({ kind, chain, text }) =>
      flightElement("p", { "data-note": kind, "data-chain": chain, children: text }),
    ),
  );
}

export type PlantedRow = { entity: string; detail: string; sourceHref: string; sourceText: string };

export function plantedRowFlight({ entity, detail, sourceHref, sourceText }: PlantedRow) {
  return flightElement("li", {
    "data-exchange-row": true,
    children: [
      flightElement("span", { "data-exchange-name": true, children: entity }),
      ", ",
      flightElement("span", { "data-exchange-detail": true, children: detail }),
      ". Source: ",
      flightElement("a", { href: sourceHref, "data-exchange-source": true, children: sourceText }),
      ".",
    ],
  });
}

export type PlantedBand = {
  key: string;
  name: string;
  amount: string;
  line: string;
  exact: string;
};

// The band as the card draws it, and its figures as the client component's props and the table's row.
// The card's one legend is the first option's, so only its line is drawn; each chain's is in the table.
export function plantedBands(bands: PlantedBand[], { withLines = true } = {}): string {
  const lines = bands
    .filter(() => withLines)
    .filter(({ key, amount }) => key === "all" && BigInt(amount) > 0n)
    .map(({ key, line }) => `<p data-exchange-linked="${key}">${line}</p>`)
    .join("");
  const rows = bands
    .filter(({ key }) => key !== "all")
    .map(({ name, exact }) => `<tr><td>${name}</td><td>${exact}</td></tr>`)
    .join("");
  const payload = [
    {
      rows: bands.map(({ key, amount }) => ({ key, journey: { placed_exchange_linked: amount } })),
    },
    ...bands
      .filter(({ key }) => key !== "all")
      .map(({ name, exact }) =>
        flightElement("tr", {
          children: [
            flightElement("td", { children: name }),
            // Flight writes a string that starts with $ as $$, or it would read as a reference.
            flightElement("td", { children: exact.replace(/^\$/, "$$$$") }),
          ],
        }),
      ),
  ];
  return `${lines}<table>${rows}</table>${plantedFlight(payload)}`;
}

export function plantedExchangeRows(
  rows: { entity: string; detail: string; sourceHref: string; sourceText: string }[],
): string {
  return rows
    .map(
      ({ entity, detail, sourceHref, sourceText }) =>
        `<li data-exchange-row><span data-exchange-name>${entity}</span>, <span data-exchange-detail>${detail}</span>. Source: <a href="${sourceHref}" rel="noopener noreferrer" data-exchange-source>${sourceText}</a>.</li>`,
    )
    .join("");
}

export const PLANTED_CARD = { id: "card", text: "T" };

export function plantedCard(
  frameWord: string | null,
  { id, text }: { id: string; text: string } = PLANTED_CARD,
): string {
  const edge = frameWord ? ` data-frame="${frameWord}"` : "";
  const word = frameWord ? `\n  · <strong>${frameWord}</strong>` : "";
  return `<section id="${id}" class="chart-card"${edge}><div class="chart-card__head"><h2>${text}</h2>
  ${plantedInfoTip("About: T", '<p>Source: S</p><a href="/methodology/#velocity">Definition</a>')}</div>
  <table></table>
  <p class="chart-card__meta">As of <time datetime="2026-11-03">3 Nov</time>${word}</p>
  <noscript><p class="chart-card__source-note">Source: S · <a href="/methodology/#velocity">Definition</a></p></noscript></section>`;
}

export type PlantedPart = {
  key: string;
  label: string;
  amount: string;
  width: string;
  share: string;
  direct: string | null;
  compact: string;
  floor: boolean;
  band: string | null;
  bandLine: string | null;
  pins: string[];
};
type PlantedPanelNote = { kind: string; chain?: string; words: string; tip?: string };
type PlantedTable = {
  columns: { key: string; label: string }[];
  rows: Record<string, string>[];
};
export type PlantedSupplyPanel = {
  value: string;
  heading: string;
  key: string | null;
  total: string | null;
  rowTotal: string;
  parts: PlantedPart[];
  stats: { key: string; label: string; value: string }[];
  notes: PlantedPanelNote[];
  table: PlantedTable;
  kpiRows: Record<string, string>[];
  placedNote: string;
  entities: number;
};
export type PlantedSeriesPanel = {
  value: string;
  heading: string;
  notes: PlantedPanelNote[];
  fullNote: string;
  rows: Record<string, string>[];
};
const SERIES_TABLE = [
  ["day", "Day"],
  ["total", "Total"],
  ["placed", "Placed"],
  ["circulating", "Circulating"],
].map(([key, label]) => ({ key, label }));
const WALLET_TABLE = [
  ["chain", "Chain"],
  ["clean", "Clean volume, 7 days"],
  ["wallets", "Active wallets, 7 days"],
].map(([key, label]) => ({ key, label }));
export const PLANTED_WALLETS_CAPTION = "Wallets, not people, and never added across chains.";

function plantedTable({ columns, rows }: PlantedTable, caption = ""): string {
  const cells = (row: Record<string, string>) =>
    columns.map(({ key, label }) => `<td data-label="${label}">${escaped(row[key])}</td>`).join("");
  return `<table><caption>${caption}</caption><tbody>${rows
    .map((row) => `<tr>${cells(row)}</tr>`)
    .join("")}</tbody></table>`;
}

// A note's short words in view, with the note in full as a tooltip on them where it has one.
export function plantedPanelNotes(notes: PlantedPanelNote[]): string {
  const items = notes.map(
    ({ kind, chain, words, tip }, index) =>
      `<li data-note="${kind}"${chain ? ` data-chain="${chain}"` : ""}><span class="pin" aria-hidden="true">${index + 1}</span><p>${tip ? plantedTip(escaped(words), escaped(tip)) : escaped(words)}</p></li>`,
  );
  return `<ol data-pinned-notes>${items.join("")}</ol>`;
}

function plantedPanelCard(
  heading: string,
  inner: string,
  panelText: string,
  toggle: string,
  id = "",
) {
  return `<section${id ? ` id="${id}"` : ""} class="chart-card"><div class="chart-card__head"><h2>${escaped(heading)}</h2>
  ${plantedInfoTip("About", `<p>Source: S</p><a href="/methodology/#velocity">Definition</a>${panelText}`)}</div>
  ${inner}<details class="data-toggle"><summary>Table</summary>${toggle}</details>
  <p class="chart-card__meta">As of <time datetime="2026-11-03">3 Nov</time></p>
  <noscript><p class="chart-card__source-note">Source: S · <a href="/methodology/#velocity">Definition</a></p></noscript></section>`;
}

function plantedSupplyBar({ key, total, parts }: PlantedSupplyPanel): string {
  if (!parts.some(({ amount }) => BigInt(amount) > 0n)) return "<p>Not enough data yet</p>";
  const drawn = parts
    .filter(({ amount }) => BigInt(amount) > 0n)
    .map(
      ({ key: part, amount, width, band, direct }) =>
        `<div data-part="${part}" data-amount="${amount}" style="flex-basis:${width}">${direct ? `<span data-direct-label>${direct}</span>` : ""}${band !== null && BigInt(band) > 0n ? '<span data-testid="exchange-linked-band"></span>' : ""}</div>`,
    );
  return `<div data-supply-bar="${key}" data-total="${total}">${drawn.join("")}</div>`;
}

function plantedLegend({ key, parts }: PlantedSupplyPanel): string {
  const rows = parts.map(({ key: part, label, compact, share, floor, pins, band, bandLine }) => {
    const mark = floor ? '<span data-coverage="floor">≥</span>' : "";
    const numbers = pins.map((pin) => `<span class="pin">${pin}</span>`).join("");
    const linked = band !== null && BigInt(band) > 0n ? ` data-exchange-linked="${key}"` : "";
    const line =
      bandLine === null ? "" : `<li data-band="${part}"><span${linked}>${bandLine}</span></li>`;
    return `<li data-segment="${part}"><span data-segment-label>${label}</span>${numbers}<span data-segment-amount>${mark}${compact}</span><span data-segment-share>${share}</span></li>${line}`;
  });
  return `<ul data-supply-legend>${rows.join("")}</ul>`;
}

// The supply card, as the view writes it: one card, a bar row per filter option, and the first
// option's legend, figures, notes and tables.
export function plantedSupplyPanels(
  panels: PlantedSupplyPanel[],
  id: string,
  rowsHtml: string,
): string {
  if (panels.length === 0) return "";
  const [all] = panels;
  const rows = panels
    .map(
      (panel) =>
        `<div data-supply-row="${panel.value}"><p><span class="supply-row__name">${panel.value}</span> <span data-row-total>${panel.rowTotal}</span></p>${plantedSupplyBar(panel)}</div>`,
    )
    .join("");
  const stats = all.stats
    .map(
      ({ key, label, value }) =>
        `<div data-stat="${key}"><dt>${label}</dt><dd data-stat-value>${value}</dd></div>`,
    )
    .join("");
  const entities = all.entities > 0 ? `<div data-labels-table><ul>${rowsHtml}</ul></div>` : "";
  const walletsTable = plantedTable(
    { columns: WALLET_TABLE, rows: all.kpiRows },
    `Last 7 days. ${PLANTED_WALLETS_CAPTION}`,
  );
  return plantedPanelCard(
    all.heading,
    `<div class="chart-area" aria-hidden="true"><div data-supply-rows>${rows}</div></div>${plantedLegend(all)}<dl>${stats}</dl>${plantedPanelNotes(all.notes)}`,
    `<p data-full-note="placed">${escaped(all.placedNote)}</p>`,
    `${plantedTable(all.table)}${walletsTable}${entities}`,
    id,
  );
}

export function plantedSeriesPanels(panels: PlantedSeriesPanel[], id: string): string {
  const items = panels.map((panel) => {
    const lines = ["Total", "Circulating", "Placed"]
      .map((line) => `<li data-series-line>${line}</li>`)
      .join("");
    return `<div data-chain-panel="${panel.value}">${plantedPanelCard(
      panel.heading,
      `<ul data-series-legend>${lines}</ul>${plantedPanelNotes(panel.notes)}`,
      `<p data-full-note="series-start">${escaped(panel.fullNote)}</p>`,
      plantedTable({ columns: SERIES_TABLE, rows: panel.rows }),
    )}</div>`;
  });
  return `<div id="${id}" class="chain-panels">${items.join("")}</div>`;
}

type PlantedActivityNote = { kind: string; words: string; step?: string };
export type PlantedWaterfallPanel = {
  value: string;
  heading: string;
  steps: { key: string; figure: string }[];
  notes: PlantedActivityNote[];
  fullNotes: Record<string, string>;
  stepRows: Record<string, string>[];
  periodRows: Record<string, string>[];
};
export type PlantedWeeklyPanel = {
  value: string;
  heading: string;
  bars: string[];
  notes: PlantedActivityNote[];
  fullNotes: Record<string, string>;
  rows: Record<string, string>[];
};
const STEP_TABLE = [
  ["step", "Step"],
  ["amount", "Amount"],
].map(([key, label]) => ({ key, label }));
const PERIOD_TABLE = [
  ["chain", "Chain"],
  ["from", "First day"],
  ["to", "Newest day"],
  ["days", "Days"],
  ["headline", "Headline"],
  ["large", "Clean large"],
  ["everyday", "Clean everyday"],
].map(([key, label]) => ({ key, label }));
const WEEK_TABLE = [
  ["week", "Week"],
  ["everyday", "Clean everyday"],
].map(([key, label]) => ({ key, label }));

function plantedActivityNotes(notes: PlantedActivityNote[]): string {
  const items = notes.map(
    ({ kind, words }, index) =>
      `<li data-note="${kind}"><span class="pin" aria-hidden="true">${index + 1}</span><p>${escaped(words)}</p></li>`,
  );
  return `<ol data-pinned-notes>${items.join("")}</ol>`;
}

function plantedFullNotes(fullNotes: Record<string, string>): string {
  return Object.entries(fullNotes)
    .map(([kind, text]) => `<p data-full-note="${kind}">${escaped(text)}</p>`)
    .join("");
}

// Each filter option's waterfall and weekly bars, as the views write them.
export function plantedWaterfallPanels(panels: PlantedWaterfallPanel[], id: string): string {
  const items = panels.map((panel) => {
    const rows = panel.steps
      .map(({ key, figure }) => {
        const pins = panel.notes
          .map((note, index) => (note.step === key ? `<span class="pin">${index + 1}</span>` : ""))
          .join("");
        return `<li data-step="${key}"><span>S${pins}</span><span class="tabular-nums">${figure}</span></li>`;
      })
      .join("");
    return `<div data-chain-panel="${panel.value}">${plantedPanelCard(
      panel.heading,
      `<div class="chart-area" aria-hidden="true"><ol>${rows}</ol></div>${plantedActivityNotes(panel.notes)}`,
      plantedFullNotes(panel.fullNotes),
      `${plantedTable({ columns: STEP_TABLE, rows: panel.stepRows })}${plantedTable({ columns: PERIOD_TABLE, rows: panel.periodRows })}`,
    )}</div>`;
  });
  return `<div id="${id}" class="chain-panels">${items.join("")}</div>`;
}

export function plantedWeeklyPanels(panels: PlantedWeeklyPanel[], id: string): string {
  const items = panels.map((panel) => {
    const pins = panel.notes.map((_, index) => `<span class="pin">${index + 1}</span>`).join("");
    const bars = panel.bars
      .map((bar) => {
        const [to, figure] = bar.split("=");
        return `<div data-week="${to}"><span data-week-value>${figure}</span></div>`;
      })
      .join("");
    return `<div data-chain-panel="${panel.value}">${plantedPanelCard(
      panel.heading,
      `<div class="chart-area" aria-hidden="true"><div data-chart-pins>${pins}</div>${bars}</div>${plantedActivityNotes(panel.notes)}`,
      plantedFullNotes(panel.fullNotes),
      plantedTable({ columns: WEEK_TABLE, rows: panel.rows }),
    )}</div>`;
  });
  return `<div id="${id}" class="chain-panels">${items.join("")}</div>`;
}

export type PlantedVelocity = {
  heading: string;
  bars: string[];
  notes: PlantedPanelNote[];
  fullWarnings: { chain: string; text: string }[];
};
export type PlantedGrid = {
  rows: {
    measure: string;
    cells: { chain: string; text: string; widthBps: number; leads: boolean }[];
  }[];
};

// The velocity card and the chain grid's card, as the views write them.
export function plantedVelocity(velocity: PlantedVelocity, id: string): string {
  const denominators =
    velocity.notes.findIndex((note) => note.kind === "velocity-denominators") + 1;
  const groups = new Map<string, string[]>();
  for (const bar of velocity.bars) {
    const [, chain, measure, value, width] = /^(\w+):(\w+)=(.*)@(.*)$/.exec(bar)!;
    const drawn =
      width === "null" || width === "0"
        ? ""
        : `<span class="velocity-chart__bar" data-width="${width}"></span>`;
    // The denominators note's pin sits on the first chain's headline row, as there's no legend.
    const pin =
      groups.size === 0 || (groups.size === 1 && groups.has(chain))
        ? measure === "headline_velocity_bps"
          ? `<span class="pin">${denominators}</span>`
          : ""
        : "";
    groups.set(chain, [
      ...(groups.get(chain) ?? []),
      `<div data-measure="${measure}"><span class="velocity-chart__label">M${pin}</span>${drawn}<span data-velocity-value>${value}</span></div>`,
    ]);
  }
  const pinOf = (chain: string) => {
    const index = velocity.notes.findIndex((note) => note.chain === chain);
    return index === -1 ? "" : `<span class="pin">${index + 1}</span>`;
  };
  const chart = [...groups]
    .map(
      ([chain, rows]) =>
        `<div data-velocity-chain="${chain}"><p class="velocity-chart__name">${chain}${pinOf(chain)}</p>${rows.join("")}</div>`,
    )
    .join("");
  const notes = plantedPanelNotes(velocity.notes);
  const fullNotes = `<p data-full-note="velocity-denominators">${escaped(VELOCITY_NOTE)}</p><p data-full-note="velocity-jumpy">${escaped(JUMPY_NOTE)}</p>`;
  const full = velocity.fullWarnings
    .map(
      ({ chain, text }) =>
        `<p data-full-note="velocity-warning" data-chain="${chain}">${escaped(text)}</p>`,
    )
    .join("");
  return `<div id="${id}">${plantedPanelCard(
    velocity.heading,
    `<div class="chart-area" aria-hidden="true">${chart}</div>${notes}`,
    `${fullNotes}${full}`,
    `<table><caption>Velocity. Wallets, not people.</caption></table>`,
  )}</div>`;
}

export function plantedGrid(grid: PlantedGrid, heading: string, id: string): string {
  const rows = grid.rows
    .map(
      ({ measure, cells }) =>
        `<tr data-grid-measure="${measure}">${cells
          .map(
            ({ chain, text, widthBps, leads }) =>
              `<td data-grid-chain="${chain}"${leads ? " data-leads" : ""}><span data-grid-value>${escaped(text)}</span><span class="chain-grid__bar" data-width="${widthBps}"></span></td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<div id="${id}">${plantedPanelCard(
    heading,
    `<table data-chain-grid><tbody>${rows}</tbody></table>`,
    "",
    "<table></table>",
  )}</div>`;
}

export function plantedFilter(options: { value: string; label: string }[]): string {
  const inputs = options.map(
    ({ value, label }, index) =>
      `<label><input type="radio" name="chain" value="${value}"${index === 0 ? " checked" : ""}/><span>${label}</span></label>`,
  );
  return `<div class="chain-filter" data-section="chain-filter"><fieldset>${inputs.join("")}</fieldset></div>`;
}

// A whole real main page, from what verify-output expects of a dataset. The trust row is at the
// top only on a build that didn't pass.
export function plantedRealMain(
  expected: {
    verdict: Verdict;
    passing: boolean;
    headStale: string;
    kpiScope: string;
    kpiValues: string[];
    essentialNotes: Note[];
    exchangeRows: Parameters<typeof plantedExchangeRows>[0];
    bands: PlantedBand[];
    filter: { value: string; label: string }[];
    supplyPanels: PlantedSupplyPanel[];
    seriesPanels: PlantedSeriesPanel[];
    waterfallPanels: PlantedWaterfallPanel[];
    weeklyPanels: PlantedWeeklyPanel[];
    velocity: PlantedVelocity;
    grid: PlantedGrid;
  },
  staleTrust: string,
): string {
  const trust = expected.passing
    ? ""
    : `<section data-section="trust-strip">${staleTrust}${PLANTED_TRUST_LINK}</section>`;
  return `<main>${trust}<section data-section="verdict">${plantedHeadline(expected.verdict)}<p>${expected.headStale}</p></section>
    <section data-section="kpi-row">${plantedKpis(expected.kpiScope, expected.kpiValues)}</section>
    ${plantedNotes(expected.essentialNotes)}
    <div class="dashboard">${plantedFilter(expected.filter)}
    ${plantedSupplyPanels(expected.supplyPanels, CARD_ANCHORS.supply, plantedExchangeRows(expected.exchangeRows))}
    ${plantedSeriesPanels(expected.seriesPanels, CARD_ANCHORS.series)}
    ${plantedWaterfallPanels(expected.waterfallPanels, CARD_ANCHORS.waterfall)}
    ${plantedWeeklyPanels(expected.weeklyPanels, CARD_ANCHORS.weekly)}
    ${plantedVelocity(expected.velocity, CARD_ANCHORS.velocity)}
    ${plantedGrid(expected.grid, "A heading.", CARD_ANCHORS.chainRoles)}</div>
    ${plantedFlight(expected.exchangeRows.map(plantedRowFlight))}
    ${plantedBands(expected.bands, { withLines: false })}</main>`;
}
