// What verify-output wants on the main page's first screen, written by hand, so a test can plant one
// fault and nothing else. Used for pages that no real build wrote.
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
export function plantedBands(bands: PlantedBand[]): string {
  const lines = bands
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
  },
  staleNote: string,
  staleTrust: string,
): string {
  return `<main><section data-section="verdict">${plantedHeadline(expected.verdict)}<p>${staleNote}</p></section>
    <section data-section="kpi-row">${plantedKpis(expected.kpiScope, expected.kpiValues)}</section>
    <section data-section="trust-strip">${staleTrust}${PLANTED_TRUST_DETAIL}</section>
    ${plantedFindings(null, expected.findings)}${PLANTED_LEGEND}${plantedNotes(expected.essentialNotes)}
    <ul>${plantedExchangeRows(expected.exchangeRows)}</ul>${plantedFlight(expected.exchangeRows.map(plantedRowFlight))}
    ${plantedBands(expected.bands)}
    ${expected.findings.map((finding) => plantedCard(null, finding)).join("")}</main>`;
}
