import type { Expected } from "./expected.ts";
import { inView, plainText, viewText } from "./dom.ts";
import { DEFINITION_LINK } from "./every-page.ts";

// Real data that's only old has no trust row at the top, and its as-of line says when the data is
// from and nothing more: the footer says it's old. Sample, preview and a failed run keep the row.
export function checkMainFreshness(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  const shownFresh = document.documentElement.dataset.freshness === "fresh";
  const verdict = viewText(document.querySelector('[data-section="verdict"]'));
  const strip = document.querySelector('[data-section="trust-strip"]');
  const trust = viewText(strip);
  if (!verdict.includes(expected.headStale)) {
    problems.push(`${page}: the verdict block has no stale text`);
  }
  if (shownFresh && expected.asOfLine.fresh && !verdict.includes(expected.asOfLine.fresh)) {
    problems.push(`${page}: the verdict block has no fresh text`);
  }
  if (expected.staleInFooter) {
    if (strip) problems.push(`${page}: real data that's only old has the trust row at the top`);
    if (/Last reconciled|out of date/.test(verdict)) {
      problems.push(`${page}: the line under the headline says more than when the data is from`);
    }
    return;
  }
  if (!strip)
    problems.push(`${page}: the trust row isn't at the top on sample, preview or a failed run`);
  // On sample or preview data the strip's own check, below, covers both.
  if (expected.frameWord) return;
  if (!trust.includes(expected.trustLine.stale)) {
    problems.push(`${page}: the trust strip has no stale text`);
  }
  if (shownFresh && expected.trustLine.fresh && !trust.includes(expected.trustLine.fresh)) {
    problems.push(`${page}: the trust strip has no fresh text`);
  }
}

// The page has no markers. A sample or preview still says, in plain words in view beside the
// headline, that it isn't a finding.
export function checkMainFrame(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  if (document.querySelector("main .status-chip, main [data-section='marker-legend']")) {
    problems.push(`${page}: a marker is back on the main page`);
  }
  const frame = document.querySelector('[data-section="verdict"] [data-verdict-frame]');
  const word = expected.frameWord;
  if (!word) {
    if (frame) problems.push(`${page}: real data says it isn't a finding`);
    return;
  }
  if (viewText(frame).trim() !== `${word}, not a finding.`) {
    problems.push(`${page}: the verdict doesn't say "${word}, not a finding." in view`);
  }
  if (!viewText(document.querySelector('[data-section="kpi-row"]')).includes(word)) {
    problems.push(`${page}: no "${word}" in the KPI row`);
  }
  if (
    !viewText(document.querySelector('[data-section="trust-strip"]')).includes("Not reconciled")
  ) {
    problems.push(`${page}: the trust strip doesn't say "Not reconciled"`);
  }
}

export const KPIS = 4;

export const TRUST_CAVEAT = "it doesn't check placed share or velocity.";

export const definitionLink = (block: Element | null | undefined) =>
  [...(block?.querySelectorAll("a[href]") ?? [])].some((link) =>
    DEFINITION_LINK.test(link.getAttribute("href")!),
  );

// The headline is the verdict's own sentence. verdict.text is verbatim, in view unless the dataset
// allows the tooltip, and everything else moved there keeps its words.
export function checkHeadline(
  page: string,
  document: Document,
  { verdict }: Expected,
  problems: string[],
) {
  const block = document.querySelector('[data-section="verdict"]');
  if (viewText(block?.querySelector("h1") ?? null).trim() !== verdict.sentence) {
    problems.push(`${page}: the headline isn't the verdict's sentence`);
  }
  // The maintainer's second review removed the question line, to give the header room.
  if (block?.querySelector('[data-section="question"]')) {
    problems.push(`${page}: the question line is back above the headline`);
  }
  // A "?" beside the headline, named "How we read this", opens how we read it.
  const help = block?.querySelector(".verdict-block__head > .tip > .tip__icon--help");
  if (help?.getAttribute("aria-label") !== "How we read this" || viewText(help).trim()) {
    problems.push(`${page}: the headline has no "?" button named "How we read this"`);
  }
  const panel = block?.querySelector(".tip__panel");
  if (verdict.textVisible) {
    if (!viewText(block).includes(verdict.text)) {
      problems.push(`${page}: verdict.text isn't in view on this dataset`);
    }
  } else if (!panel?.textContent.includes(verdict.text)) {
    problems.push(`${page}: verdict.text is neither in view nor in its tooltip`);
  }
  if (verdict.items.some((item: string) => !panel?.textContent!.includes(item))) {
    problems.push(`${page}: the headline's tooltip has lost a verdict item`);
  }
  if (!definitionLink(panel))
    problems.push(`${page}: the headline's tooltip has no definition link`);
}

export function checkKpiRow(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  const row = document.querySelector('[data-section="kpi-row"]');
  const cells = [...(row?.querySelectorAll("dl > div") ?? [])];
  if (cells.length !== KPIS) problems.push(`${page}: the KPI row has ${cells.length} cells`);
  cells.forEach((cell, index) => {
    const label = viewText(cell.querySelector("dt")).trim();
    if (!label) problems.push(`${page}: a KPI has no label`);
    const value = viewText(cell.querySelector("[data-kpi-value]")).trim();
    if (!value) {
      problems.push(`${page}: a KPI has no value in view`);
    } else if (value !== expected.kpiValues[index]) {
      problems.push(`${page}: ${label} isn't the dataset's figure`);
    }
    const panel = cell.querySelector(".tip__panel");
    if (!panel?.querySelector("[data-kpi-note]")?.textContent.trim()) {
      problems.push(`${page}: a KPI's tooltip has no note`);
    }
    if (!definitionLink(panel)) problems.push(`${page}: a KPI's tooltip has no definition link`);
    if (!definitionLink(cell.querySelector("noscript"))) {
      problems.push(`${page}: a KPI's noscript note has no definition link`);
    }
  });
  // The row names its chains only when one is missing.
  if (expected.kpiScope && !viewText(row).includes(expected.kpiScope)) {
    problems.push(`${page}: the KPI row doesn't say which chains it covers`);
  } else if (!expected.kpiScope && viewText(row).includes("Across ")) {
    problems.push(`${page}: the KPI row lists every chain under it`);
  }
}

// Explanations float: a details element on the main page is a data toggle or a card's footnotes,
// which the maintainer chose to open inside the card, so no popover or accordion can push the page
// down again.
export function checkNoPushDown(page: string, document: Document, problems: string[]) {
  for (const details of document.querySelectorAll("main details")) {
    if (
      !details.classList.contains("data-toggle") &&
      !details.matches(".chart-card > .footnotes")
    ) {
      problems.push(`${page}: an explanation pushes the page down, in a details element`);
    }
  }
}

const PIN_NUMBER = /^\d+$/;

// A card's footnotes: a details element whose summary says "Footnotes", so it opens by keyboard and
// with JavaScript off, holding a numbered list. Null if it's missing or not like that.
export function footnoteList(card: Element) {
  const details = card.querySelector(":scope > [data-footnotes]");
  if (details?.tagName !== "DETAILS") return null;
  if (plainText(details.querySelector(":scope > summary")) !== "Footnotes") return null;
  return details.querySelector(":scope > ol");
}

// A footnote's words, if a marker in view in its card links to it: the maintainer's call after the
// page reviews, over the rule that a caveat's words stay in view.
function footnoteWords(item: Element) {
  const card = item.closest(".chart-card");
  if (!card || footnoteList(card) !== item.parentElement || !item.id) return "";
  const marked = [...card.querySelectorAll(`a[data-fn-ref][href="#${item.id}"]`)].some(
    (marker) => inView(marker) && PIN_NUMBER.test(plainText(marker)),
  );
  return marked ? item.textContent : "";
}

// The caveats needed to read a number, wherever a unit pins them. Each required instance has a
// marker in view in its card and its words in that card's footnotes, read whole so a date or a link
// can't split a sentence.
export function checkEssentialNotes(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  for (const { kind, chain, text, exact } of expected.essentialNotes) {
    const selector = `.footnotes__list > li[data-note="${kind}"]${chain ? `[data-chain="${chain}"]` : ""}`;
    const items = [...document.querySelectorAll(selector)];
    const shown = items
      .map((item) => footnoteWords(item).replace(/\s+/g, " "))
      .filter((words) => words.trim());
    const said = items.map((item) =>
      (item.querySelector("[data-note-text]")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    const name = `the ${kind} note${chain ? ` for ${chain}` : ""}`;
    if (shown.length === 0) {
      problems.push(`${page}: ${name} has no marker in view and footnote with its words`);
    } else if (
      !said.some((words) => (exact ? words === text : words.includes(text))) ||
      !shown.some((words) => words.includes(text))
    ) {
      problems.push(`${page}: ${name} doesn't say "${text}"`);
    }
  }
}
