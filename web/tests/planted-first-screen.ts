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

export function plantedNotes(notes: Note[]): string {
  return notes
    .map(
      ({ kind, chain, text }) =>
        `<p data-note="${kind}"${chain ? ` data-chain="${chain}"` : ""}>${text}</p>`,
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
  },
  staleNote: string,
  staleTrust: string,
): string {
  return `<main><section data-section="verdict">${plantedHeadline(expected.verdict)}<p>${staleNote}</p></section>
    <section data-section="kpi-row">${plantedKpis(expected.kpiScope, expected.kpiValues)}</section>
    <section data-section="trust-strip">${staleTrust}${PLANTED_TRUST_DETAIL}</section>
    ${plantedFindings(null, expected.findings)}${PLANTED_LEGEND}${plantedNotes(expected.essentialNotes)}
    ${expected.findings.map((finding) => plantedCard(null, finding)).join("")}</main>`;
}
