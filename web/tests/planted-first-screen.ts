// What verify-output wants on the main page's first screen, written by hand, so a test can plant one
// fault and nothing else. Used for pages that no real build wrote.
import { CARD_ANCHORS } from "@/lib/definitions";

type Verdict = { sentence: string; text: string; textVisible: boolean; items: string[] };
type Note = { kind: string; chain?: string; text: string };
type Finding = { id: string; text: string };

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

export function plantedHeadline(verdict: Verdict = PLANTED_VERDICT): string {
  const text = `<p data-verdict-text>${escaped(verdict.text)}</p>`;
  const items = verdict.items.map((item) => `<li>${escaped(item)}</li>`).join("");
  return `<p data-section="question">A question?</p><h1>${escaped(verdict.sentence)}</h1>
    <details class="info-popover" name="info"><summary aria-label="About this reading"></summary>
    <div class="info-popover__panel"><a href="/methodology/#verdict">How we read this</a>
    ${verdict.textVisible ? "" : text}<ul>${items}</ul></div></details>
    ${verdict.textVisible ? text : ""}`;
}

const kpiCell = (value: string) => `<div><dt>A label</dt><dd><span data-kpi-value>${value}</span>
  <span class="status-chip" data-kind="fact"><span aria-hidden="true">F</span><span class="sr-only">Fact</span></span></dd>
  <dd><details class="info-popover" name="info"><summary aria-label="About: A label"></summary>
  <div class="info-popover__panel"><p data-kpi-note>A note.</p><a href="/methodology/#velocity">Definition</a></div></details>
  <noscript><p>A note. <a href="/methodology/#velocity">Definition</a></p></noscript></dd></div>`;

export function plantedKpis(
  scope: string = PLANTED_KPI_SCOPE,
  values: string[] = PLANTED_KPI_VALUES,
): string {
  return `<dl>${values.map(kpiCell).join("")}</dl><p>${scope}</p>`;
}

export const PLANTED_FINDING_TARGET = "card";

// All four on the one planted card, so a test can plant one fault in them.
export const PLANTED_FINDINGS: Finding[] = Array(4).fill({ id: PLANTED_FINDING_TARGET, text: "T" });

// Each links to a planted card, and reads as that card's heading and marker.
export function plantedFindings(
  frameWord: string | null,
  findings: Finding[] = PLANTED_FINDINGS,
): string {
  const word = frameWord ? `<strong>${frameWord}</strong>` : "";
  const edge = frameWord ? ` data-frame="${frameWord}"` : "";
  const links = findings.map(
    ({ id, text }) => `<li><a href="#${id}" class="finding" data-finding-link${edge}>
    <span class="finding__text">${text}</span>
    <span class="finding__marks"><span class="status-chip" data-kind="fact">F</span>${word}</span></a></li>`,
  );
  return `<section data-section="findings"><ul>${links.join("")}</ul></section>`;
}

export const PLANTED_LEGEND = `<div data-section="marker-legend"><p>F Fact, I Inferred, E Estimate</p>
  <details class="info-popover" name="info"><summary aria-label="What the markers mean"></summary>
  <div class="info-popover__panel"><a href="/methodology/#fact-estimate-opinion">Fact, estimate and opinion</a></div></details></div>`;

export const PLANTED_TRUST_DETAIL = `<details class="accordion"><summary>Reconciliation detail</summary>
  <a href="/methodology/#reconciliation">What this covers</a>
  <p>It doesn't verify placed share or velocity.</p></details>`;

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
export function plantedBands(bands: PlantedBand[], { withLines = true } = {}): string {
  const lines = bands
    .filter(() => withLines)
    .filter(({ amount }) => BigInt(amount) > 0n)
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

export function plantedCard(
  frameWord: string | null,
  { id, text }: Finding = PLANTED_FINDINGS[0],
): string {
  const edge = frameWord ? ` data-frame="${frameWord}"` : "";
  const word = frameWord ? `\n  · <strong>${frameWord}</strong>` : "";
  return `<section id="${id}" class="chart-card"${edge}><div class="chart-card__head"><h2>${text}</h2>
  <span class="status-chip" data-kind="fact">F</span>
  <details class="info-popover" name="info"><summary aria-label="About: T"></summary>
  <div class="info-popover__panel"><p>Source: S</p><a href="/methodology/#velocity">Definition</a></div></details></div>
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
type PlantedPanelNote = { kind: string; chain?: string; words: string };
type PlantedTable = {
  columns: { key: string; label: string }[];
  rows: Record<string, string>[];
};
export type PlantedSupplyPanel = {
  value: string;
  heading: string;
  key: string | null;
  total: string | null;
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
  latest: string[];
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

function plantedPanelNotes(notes: PlantedPanelNote[]): string {
  const items = notes.map(
    ({ kind, chain, words }, index) =>
      `<li data-note="${kind}"${chain ? ` data-chain="${chain}"` : ""}><span class="pin" aria-hidden="true">${index + 1}</span><p>${escaped(words)}</p></li>`,
  );
  return `<ol data-pinned-notes>${items.join("")}</ol>`;
}

function plantedPanelCard(heading: string, inner: string, panelText: string, toggle: string) {
  return `<section class="chart-card"><div class="chart-card__head"><h2>${escaped(heading)}</h2>
  <span class="status-chip" data-kind="fact">F</span>
  <details class="info-popover" name="info"><summary aria-label="About"></summary>
  <div class="info-popover__panel"><p>Source: S</p><a href="/methodology/#velocity">Definition</a>${panelText}</div></details></div>
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

// Each filter option's supply card and step line, as the views write them.
export function plantedSupplyPanels(
  panels: PlantedSupplyPanel[],
  id: string,
  rowsHtml: string,
): string {
  const items = panels.map((panel) => {
    const stats = panel.stats
      .map(
        ({ key, label, value }) =>
          `<div data-stat="${key}"><dt>${label}</dt><dd data-stat-value>${value}</dd></div>`,
      )
      .join("");
    const entities = panel.entities > 0 ? `<div data-labels-table><ul>${rowsHtml}</ul></div>` : "";
    const walletsTable = plantedTable(
      { columns: WALLET_TABLE, rows: panel.kpiRows },
      `Last 7 days. ${PLANTED_WALLETS_CAPTION}`,
    );
    return `<div data-chain-panel="${panel.value}">${plantedPanelCard(
      panel.heading,
      `${plantedSupplyBar(panel)}${plantedLegend(panel)}<dl>${stats}</dl>${plantedPanelNotes(panel.notes)}`,
      `<p data-full-note="placed">${escaped(panel.placedNote)}</p>`,
      `${plantedTable(panel.table)}${walletsTable}${entities}`,
    )}</div>`;
  });
  return `<div id="${id}" class="chain-panels">${items.join("")}</div>`;
}

export function plantedSeriesPanels(panels: PlantedSeriesPanel[], id: string): string {
  const items = panels.map((panel) => {
    const lines = panel.latest
      .map((figure) => `<li data-series-line><span data-series-value>${figure}</span></li>`)
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

export function plantedFilter(options: { value: string; label: string }[]): string {
  const inputs = options.map(
    ({ value, label }, index) =>
      `<label><input type="radio" name="chain" value="${value}"${index === 0 ? " checked" : ""}/><span>${label}</span></label>`,
  );
  return `<div class="chain-filter" data-section="chain-filter"><fieldset>${inputs.join("")}</fieldset></div>`;
}

// A whole real main page, from what verify-output expects of a dataset.
export function plantedRealMain(
  expected: {
    verdict: Verdict;
    kpiScope: string;
    kpiValues: string[];
    findings: Finding[];
    essentialNotes: Note[];
    exchangeRows: Parameters<typeof plantedExchangeRows>[0];
    bands: PlantedBand[];
    filter: { value: string; label: string }[];
    supplyPanels: PlantedSupplyPanel[];
    seriesPanels: PlantedSeriesPanel[];
  },
  staleNote: string,
  staleTrust: string,
): string {
  const others = expected.findings.filter(({ id }) => id !== CARD_ANCHORS.supply);
  return `<main><section data-section="verdict">${plantedHeadline(expected.verdict)}<p>${staleNote}</p></section>
    <section data-section="kpi-row">${plantedKpis(expected.kpiScope, expected.kpiValues)}</section>
    <section data-section="trust-strip">${staleTrust}${PLANTED_TRUST_DETAIL}</section>
    ${plantedFindings(null, expected.findings)}${PLANTED_LEGEND}${plantedNotes(expected.essentialNotes)}
    <div class="dashboard">${plantedFilter(expected.filter)}
    ${plantedSupplyPanels(expected.supplyPanels, CARD_ANCHORS.supply, plantedExchangeRows(expected.exchangeRows))}
    ${plantedSeriesPanels(expected.seriesPanels, CARD_ANCHORS.series)}</div>
    ${plantedFlight(expected.exchangeRows.map(plantedRowFlight))}
    ${plantedBands(expected.bands, { withLines: false })}
    ${others.map((finding) => plantedCard(null, finding)).join("")}</main>`;
}
