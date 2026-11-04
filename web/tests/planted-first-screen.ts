// What verify-output wants on the main page's first screen, written by hand, so a test can plant one
// fault and nothing else. Used for pages that no real build wrote.
type Verdict = { sentence: string; text: string; textVisible: boolean; items: string[] };
type Note = { kind: string; chain?: string };

export const PLANTED_VERDICT: Verdict = {
  sentence: "A headline.",
  text: "The verdict's text, 12% & more.",
  textVisible: true,
  items: ["A fact.", "An estimate."],
};

export const PLANTED_KPI_SCOPE = "Across Tempo.";

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

const KPI_CELL = `<div><dt>A label</dt><dd><span data-kpi-value>$1</span>
  <span class="status-chip" data-kind="fact"><span aria-hidden="true">F</span><span class="sr-only">Fact</span></span></dd>
  <dd><details class="info-popover" name="info"><summary aria-label="About: A label"></summary>
  <div class="info-popover__panel"><p data-kpi-note>A note.</p><a href="/methodology/#velocity">Definition</a></div></details>
  <noscript><p>A note. <a href="/methodology/#velocity">Definition</a></p></noscript></dd></div>`;

export function plantedKpis(scope: string = PLANTED_KPI_SCOPE): string {
  return `<dl>${KPI_CELL.repeat(4)}</dl><p>${scope}</p>`;
}

export const PLANTED_FINDING_TARGET = "card";

// Each links to the planted card, and reads as that card's heading and marker.
export function plantedFindings(frameWord: string | null): string {
  const word = frameWord ? `<strong>${frameWord}</strong>` : "";
  const edge = frameWord ? ` data-frame="${frameWord}"` : "";
  const link = `<li><a href="#${PLANTED_FINDING_TARGET}" class="finding" data-finding-link${edge}>
    <span class="finding__text">T</span>
    <span class="finding__marks"><span class="status-chip" data-kind="fact">F</span>${word}</span></a></li>`;
  return `<section data-section="findings"><ul>${link.repeat(4)}</ul></section>`;
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
      ({ kind, chain }) =>
        `<p data-note="${kind}"${chain ? ` data-chain="${chain}"` : ""}>A caveat.</p>`,
    )
    .join("");
}

export function plantedCard(frameWord: string | null): string {
  const edge = frameWord ? ` data-frame="${frameWord}"` : "";
  const word = frameWord ? `\n  · <strong>${frameWord}</strong>` : "";
  return `<section id="${PLANTED_FINDING_TARGET}" class="chart-card"${edge}><div class="chart-card__head"><h2>T</h2>
  <span class="status-chip" data-kind="fact">F</span>
  <details class="info-popover" name="info"><summary aria-label="About: T"></summary>
  <div class="info-popover__panel"><p>Source: S</p><a href="/methodology/#velocity">Definition</a></div></details></div>
  <table></table>
  <p class="chart-card__meta">As of <time datetime="2026-11-03">3 Nov</time>${word}</p>
  <noscript><p class="chart-card__source-note">Source: S · <a href="/methodology/#velocity">Definition</a></p></noscript></section>`;
}

// A whole real main page, from what verify-output expects of a dataset.
export function plantedRealMain(
  expected: { verdict: Verdict; kpiScope: string; essentialNotes: Note[] },
  staleNote: string,
  staleTrust: string,
): string {
  return `<main><section data-section="verdict">${plantedHeadline(expected.verdict)}<p>${staleNote}</p></section>
    <section data-section="kpi-row">${plantedKpis(expected.kpiScope)}</section>
    <section data-section="trust-strip">${staleTrust}${PLANTED_TRUST_DETAIL}</section>
    ${plantedFindings(null)}${PLANTED_LEGEND}${plantedNotes(expected.essentialNotes)}${plantedCard(null)}</main>`;
}
