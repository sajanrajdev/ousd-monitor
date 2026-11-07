// Runs on every build. Reads what was really written, and takes what to expect from the dataset, not
// from an argument, so no build can talk its way past it. Usage: verify-output.mjs <output folder>
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { loadDatasetFiles, locateDataset } from "../lib/dataset/load.ts";
import { deriveState } from "../lib/dataset/state.ts";
import { allChainKpis, newestByChain } from "../lib/aggregate.ts";
import { chainOptions } from "../lib/chain-scope.ts";
import { CARD_ANCHORS, CHAIN_NAMES, REQUIRED_CHAINS, TOKEN_CONTRACTS } from "../lib/definitions.ts";
import { chainExchangeRows, exchangeRows } from "../lib/exchange-rows.ts";
import {
  formatBps,
  formatCompact,
  formatExact,
  formatFloorDollars,
  UNKNOWN_TEXT,
} from "../lib/format.ts";
import {
  day0Scope,
  historyLabel,
  stepFigure,
  velocityHeading,
  velocityWarnings,
  waterfall,
  weeklyEveryday,
} from "../lib/takeaways/activity.ts";
import {
  PERIOD_COLUMNS,
  STEP_COLUMNS,
  waterfallPanel,
  WEEK_COLUMNS,
  weeklyPanel,
} from "../lib/activity-panels.ts";
import {
  day0Pin,
  everydayNote,
  EXCHANGE_FLOOR_PIN,
  exchangeCoveragePin,
  historyPin,
  HOPS_NOTE,
  issuerUnlabeledNote,
  NO_SWAPS_NOTE,
  PLACED_NOTE,
  PLACED_PIN,
  seriesStartNote,
  seriesStartPin,
  SMALL_TICKET_PIN,
  JUMPY_NOTE,
  VELOCITY_NOTE,
  VELOCITY_PIN,
  WALLETS_ACROSS_CHAINS_NOTE,
  WALLETS_NOTE,
} from "../lib/takeaways/caveats.ts";
import {
  directLabel,
  legendAmount,
  segmentLabel,
  seriesPanel,
  supplyPanel,
} from "../lib/supply-segments.ts";
import { velocityChart } from "../lib/chain-views.ts";
import { exchangeLinkedBands } from "../lib/takeaways/journey.ts";
import { verdictSentence, verdictTextVisible } from "../lib/verdict.ts";

const INDEPENDENCE_LINE = "Independent. Not affiliated with Open Standard or Bridge.";
const FRESH_SENTENCE = "Supply reconciled on all 4 chains";
// Everything else is read as text, so a new kind of output file can't slip past unread.
const BINARY_EXTENSIONS = new Set([".woff", ".woff2", ".ttf", ".otf", ".eot", ".ico", ".png"]);
const EVM_ADDRESS = /0[xX][0-9a-fA-F]{40}(?![0-9a-zA-Z])/g;
const BASE58_ADDRESS = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g;
const CSS_REQUEST = /(url\(|@import)\s*['"]?(https?:)?\/\//;
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
// A shorter string could match ordinary page text, and says nothing about a pipeline leak.
const MIN_PIPELINE_STRING = 8;
const REQUEST_ATTRIBUTES = [
  ["script", "src"],
  ["link", "href"],
  ["img", "src"],
  ["source", "src"],
  ["iframe", "src"],
  ["video", "src"],
  ["audio", "src"],
  ["embed", "src"],
  ["object", "data"],
  ["form", "action"],
];

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const OUT_OF_VIEW = [
  "noscript",
  "template",
  "script",
  "style",
  "[hidden]",
  ".sr-only",
  // A tooltip's panel shows only on hover or focus, so nothing in it is in view.
  ".tip__panel",
  '[style*="display:none"]',
  '[style*="display: none"]',
  '[style*="visibility:hidden"]',
  '[style*="visibility: hidden"]',
].join(", ");

// What an inline style or a class can hide, read as written, however it is spaced. A class list with
// a responsive reveal, such as "hidden md:block", shows at some width, so the browser checks judge it.
const HIDING_STYLE = [
  /display:none/,
  /visibility:(hidden|collapse)/,
  /opacity:0(\.0+)?(;|$)/,
  /font-size:0([a-z%]*)(;|$)/,
  /(left|right|top|bottom|margin-[a-z]+|text-indent):-\d{3,}/,
  /translate[xyz3d]*\(-\d{3,}/,
];
const REVEALED_CLASS =
  /^[a-z0-9-]+:(block|flex|grid|inline|inline-block|inline-flex|table|contents)$/;

function hiddenByMarkup(element) {
  const style = (element.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();
  if (HIDING_STYLE.some((pattern) => pattern.test(style))) return true;
  const classes = [...element.classList];
  return classes.includes("hidden") && !classes.some((name) => REVEALED_CLASS.test(name));
}

function outOfView(element) {
  if (element.closest(OUT_OF_VIEW)) return true;
  for (let at = element; at; at = at.parentElement) {
    if (hiddenByMarkup(at)) return true;
  }
  return false;
}

// In view with nothing opened: not hidden, and inside no details but in its summary. CSS can't be
// read here, so the browser checks in acceptance.mjs cover what a stylesheet hides.
function inView(element) {
  if (outOfView(element)) return false;
  for (let d = element.closest("details"); d; d = d.parentElement?.closest("details")) {
    if (!d.querySelector(":scope > summary")?.contains(element)) return false;
  }
  return true;
}

function viewText(element, joiner = " ") {
  if (!element || !inView(element)) return "";
  const { NodeFilter } = element.ownerDocument.defaultView;
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (inView(node.parentElement)) text += `${node.data}${joiner}`;
  }
  return text;
}

// The card's visible line.
function visibleMeta(card) {
  return [...card.querySelectorAll(".chart-card__meta")].find(inView);
}

// Every text node, for the scans that must find a thing wherever it sits, seen or not.
function allTextNodes(document) {
  const { NodeFilter } = document.defaultView;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement.closest("script, style, template")) nodes.push(node);
  }
  return nodes;
}

function escapedNameMatcher(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`);
}

// The header keeps only the name, so the independence line is the footer's, in view with nothing
// opened, on every page.
function checkEveryPage(page, document, problems) {
  const footer = viewText(document.querySelector("footer"));
  if (!footer.includes(INDEPENDENCE_LINE)) {
    problems.push(`${page}: no independence line in the footer`);
  }
  if (!/not financial advice/i.test(footer)) problems.push(`${page}: no "not financial advice"`);
  if (!document.querySelector('footer a[href^="/methodology"]')) {
    problems.push(`${page}: no methodology link in the footer`);
  }
  if (!document.querySelector('header a[href^="/methodology"]')) {
    problems.push(`${page}: no methodology link in the header`);
  }
  if (!document.querySelector('header a[href="/"]')) {
    problems.push(`${page}: the site's name in the header doesn't link to /`);
  }
  // Every page but the dashboard has a clear way back to it, above its title.
  if (page !== "index.html" && !/^(404|_not-found)/.test(page))
    checkBackLink(page, document, problems);
}

// An arrow named "Back to the dashboard" for assistive tech, before the page's title.
function checkBackLink(page, document, problems) {
  const back = [...document.querySelectorAll('main a[href="/"]')].find(
    (link) =>
      (link.getAttribute("aria-label") ?? viewText(link)).trim() === "Back to the dashboard" &&
      inView(link),
  );
  const title = document.querySelector("main h1");
  if (!back) {
    problems.push(`${page}: no "Back to the dashboard" link to /`);
  } else if (
    !title ||
    !(
      back.compareDocumentPosition(title) &
      back.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING
    )
  ) {
    problems.push(`${page}: the way back isn't above the page's title`);
  }
}

const RECONCILED = /\bReconciled\b/;

// The tooltip a footer status link describes.
function footerTip(document, element) {
  const link = element?.querySelector('a[href="/reconciliation/"]');
  return link && document.getElementById(link.getAttribute("aria-describedby") ?? "");
}

// "Reconciled", in green with a tick, is for a build that passed. On any other it's nowhere in the
// footer, seen or swapped out, so a reader's clock can't reveal it either. Real data that's old, or
// that a reader's clock finds old, has an amber clock and "Last reconciled" with the day, and the
// dated sentence as its tooltip. Each links to the detail page.
function checkFooterStatus(page, document, expected, problems) {
  const status = document.querySelector("footer [data-footer-status]");
  if (!status) {
    problems.push(`${page}: no reconciliation status in the footer`);
    return;
  }
  const marked = status.querySelectorAll("[data-reconciled]");
  // The words in the footer itself, each apart, with the tooltips left out.
  const own = status.cloneNode(true);
  for (const panel of own.querySelectorAll(".tip__panel")) panel.remove();
  const words = [...own.querySelectorAll("*")].map((element) => element.textContent).join(" ");
  if (!expected.passing && (marked.length > 0 || RECONCILED.test(words))) {
    problems.push(`${page}: the footer says "Reconciled" on a build that didn't pass`);
  }
  if (expected.kind !== "real") {
    if (!viewText(status).includes(expected.trustLine.stale)) {
      problems.push(`${page}: the footer's status doesn't say "${expected.trustLine.stale}"`);
    }
  } else {
    const stale = status.querySelectorAll("[data-stale-status]");
    const clock = stale[0];
    if (stale.length !== 1 || !clock.closest(".freshness-text__stale")) {
      problems.push(`${page}: the footer has no clock state to show once the data is old`);
    } else {
      if (
        clock.querySelector(".tip__trigger")?.textContent.trim() !== expected.trustLine.short ||
        RECONCILED.test(clock.textContent) ||
        !clock.querySelector("svg circle")
      ) {
        problems.push(
          `${page}: the footer's clock state isn't a clock and "${expected.trustLine.short}"`,
        );
      }
      if (!footerTip(document, clock)?.textContent.includes(expected.trustLine.stale)) {
        problems.push(`${page}: the footer's clock state has no tooltip with the dated sentence`);
      }
      if (!expected.passing && !inView(clock)) {
        problems.push(`${page}: the footer's clock state isn't in view on old data`);
      }
    }
  }
  if (expected.passing) {
    const word = marked[0];
    if (marked.length !== 1 || !word.closest(".freshness-text__fresh")) {
      problems.push(`${page}: the footer's "Reconciled" isn't its fresh text, once`);
    } else if (viewText(word).trim() !== "Reconciled" || !word.querySelector("svg path")) {
      problems.push(`${page}: the footer's "Reconciled" lost its tick or its word`);
    }
    if (!footerTip(document, word)?.textContent.includes(expected.trustLine.fresh)) {
      problems.push(`${page}: the footer's "Reconciled" has no tooltip with the dated sentence`);
    }
  }
  if (!status.querySelector('a[href="/reconciliation/"]')) {
    problems.push(`${page}: the footer's status doesn't link to the reconciliation page`);
  }
}

function checkStateOnPage(page, document, expected, problems) {
  const root = document.documentElement;
  if (root.dataset.datasetKind !== expected.kind) {
    problems.push(
      `${page}: page root says ${root.dataset.datasetKind}, dataset is ${expected.kind}`,
    );
  }
  if (root.dataset.datasetVersion !== expected.version) {
    problems.push(`${page}: built from another dataset version`);
  }
  const word = expected.frameWord;
  const banner = document.querySelector("[data-dataset-banner]");
  if (!word) {
    if (banner || root.dataset.frame) problems.push(`${page}: real data has the non-real frame`);
    return;
  }
  if (root.dataset.frame !== word) problems.push(`${page}: no ${word} frame on the page root`);
  if (!viewText(banner).trim()) problems.push(`${page}: no ${word} banner`);
  if (!document.title.startsWith(`[${word}]`)) problems.push(`${page}: no [${word}] in the title`);
  const robots = document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "";
  if (!robots.includes("noindex")) problems.push(`${page}: no noindex`);
  for (const card of document.querySelectorAll(".chart-card")) {
    if (card.getAttribute("data-frame") !== word) {
      problems.push(`${page}: a card has no ${word} edge`);
    }
    if (!viewText(visibleMeta(card)).includes(word)) {
      problems.push(`${page}: a card has no "${word}" beside its as-of time`);
    }
  }
}

// Every page says when its data is out of date. On sample or preview data, or after a failed run, a
// note at the top does, there while fresh too, for the clock. On real data that's only old, the
// footer's clock state does, and nothing sits between the header and the page.
function checkFreshnessOnPage(page, document, expected, problems) {
  const shown = document.documentElement.dataset.freshness;
  if (shown !== "fresh" && shown !== "stale") {
    problems.push(`${page}: no freshness on the page root`);
  } else if (expected.freshness === "stale" && shown !== "stale") {
    problems.push(`${page}: page root says fresh, dataset is stale`);
  }
  const found = document.querySelector("[data-stale-note]");
  if (expected.staleInFooter) {
    if (found) problems.push(`${page}: a stale note is at the top of real data`);
    return;
  }
  if (!viewText(found).includes(expected.asOfLine.stale)) problems.push(`${page}: no stale note`);
}

// Real data that's only old has no trust row at the top, and its as-of line says when the data is
// from and nothing more: the footer says it's old. Sample, preview and a failed run keep the row.
function checkMainFreshness(page, document, expected, problems) {
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
function checkMainFrame(page, document, expected, problems) {
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

const KPIS = 4;
const TRUST_CAVEAT = "it doesn't check placed share or velocity.";

const definitionLink = (block) =>
  [...(block?.querySelectorAll("a[href]") ?? [])].some((link) =>
    DEFINITION_LINK.test(link.getAttribute("href")),
  );

// The headline is the verdict's own sentence. verdict.text is verbatim, in view unless the dataset
// allows the tooltip, and everything else moved there keeps its words.
function checkHeadline(page, document, { verdict }, problems) {
  const block = document.querySelector('[data-section="verdict"]');
  if (viewText(block?.querySelector("h1")).trim() !== verdict.sentence) {
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
  if (verdict.items.some((item) => !panel?.textContent.includes(item))) {
    problems.push(`${page}: the headline's tooltip has lost a verdict item`);
  }
  if (!definitionLink(panel))
    problems.push(`${page}: the headline's tooltip has no definition link`);
}

function checkKpiRow(page, document, expected, problems) {
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

// The trust row's disclosure is its own page now, with a way back to the dashboard.
function checkReconciliationPage(page, document, expected, problems) {
  const detail = document.querySelectorAll('main [data-section="reconciliation"]');
  if (detail.length !== 1) {
    problems.push(`${page}: there are ${detail.length} reconciliation details, not one`);
    return;
  }
  const text = viewText(detail[0]);
  if (!text.includes(TRUST_CAVEAT)) {
    problems.push(`${page}: the detail has lost what it says it doesn't verify`);
  }
  const line = detail[0].querySelector("[data-run-line]");
  if (!line?.textContent.includes(expected.runLine.stale)) {
    problems.push(`${page}: the detail doesn't state the reconciliation's state`);
  }
  if (detail[0].querySelectorAll("[data-check-list] > div").length !== expected.checkCount) {
    problems.push(`${page}: the detail doesn't list every check with its result`);
  }
  if (!definitionLink(detail[0])) problems.push(`${page}: the detail has no definition link`);
  if (!detail[0].querySelector("table") && !text.includes(UNKNOWN_TEXT)) {
    problems.push(`${page}: the detail has neither its table nor "${UNKNOWN_TEXT}"`);
  }
  checkBackLink(page, document, problems);
}

// Explanations float: a details element on the main page is a data toggle or a card's footnotes,
// which the maintainer chose to open inside the card, so no popover or accordion can push the page
// down again.
function checkNoPushDown(page, document, problems) {
  for (const details of document.querySelectorAll("main details")) {
    if (
      !details.classList.contains("data-toggle") &&
      !details.matches(".chart-card > .footnotes")
    ) {
      problems.push(`${page}: an explanation pushes the page down, in a details element`);
    }
  }
}

const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

// Every tooltip is reached by keyboard: its trigger is a native button or link, with a name, and
// points at its panel, which comes straight after it, so Tab moves from one into the other. A panel
// with anything focusable is a disclosure, with aria-expanded, as role="tooltip" can't hold a link.
function checkTooltips(page, document, problems) {
  for (const tip of document.querySelectorAll("[data-tip]")) {
    const trigger = tip.querySelector(":scope > .tip__trigger");
    const panel = tip.querySelector(":scope > .tip__panel");
    const name = trigger?.getAttribute("aria-label")?.trim() || trigger?.textContent.trim();
    const native =
      trigger?.tagName === "BUTTON" || (trigger?.tagName === "A" && trigger.hasAttribute("href"));
    if (!trigger || !native || trigger.getAttribute("tabindex") === "-1" || !name) {
      problems.push(`${page}: a tooltip's trigger can't be reached by keyboard, or has no name`);
      continue;
    }
    if (!panel?.id || trigger.nextElementSibling !== panel) {
      problems.push(`${page}: a tooltip's panel doesn't follow its trigger`);
      continue;
    }
    const interactive = panel.querySelector(FOCUSABLE) !== null;
    if (interactive) {
      if (
        trigger.getAttribute("aria-controls") !== panel.id ||
        !trigger.hasAttribute("aria-expanded") ||
        panel.getAttribute("role") === "tooltip"
      ) {
        problems.push(`${page}: a tooltip with a link isn't a disclosure`);
      }
    } else if (
      trigger.getAttribute("aria-describedby") !== panel.id &&
      trigger.getAttribute("aria-controls") !== panel.id
    ) {
      problems.push(`${page}: a tooltip's trigger doesn't point at its panel`);
    } else if (
      trigger.getAttribute("aria-describedby") === panel.id &&
      panel.getAttribute("role") !== "tooltip"
    ) {
      problems.push(`${page}: a tooltip describing its trigger has no role="tooltip"`);
    }
  }
}

const PIN_NUMBER = /^\d+$/;

// A card's footnotes: a details element whose summary says "Footnotes", so it opens by keyboard and
// with JavaScript off, holding a numbered list. Null if it's missing or not like that.
function footnoteList(card) {
  const details = card.querySelector(":scope > [data-footnotes]");
  if (details?.tagName !== "DETAILS") return null;
  if (plainText(details.querySelector(":scope > summary")) !== "Footnotes") return null;
  return details.querySelector(":scope > ol");
}

// A footnote's words, if a marker in view in its card links to it: the maintainer's call after the
// page reviews, over the rule that a caveat's words stay in view.
function footnoteWords(item) {
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
function checkEssentialNotes(page, document, expected, problems) {
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

function checkAddresses(page, texts, allowedAddresses, problems) {
  for (const text of texts) {
    const found = [...text.matchAll(EVM_ADDRESS), ...text.matchAll(BASE58_ADDRESS)].map(
      (match) => match[0],
    );
    for (const address of found) {
      const allowed = allowedAddresses.has(address) || allowedAddresses.has(address.toLowerCase());
      // Never print it: an address that isn't meant to be public shouldn't reach a log either.
      if (!allowed) problems.push(`${page}: an address in the page`);
    }
  }
}

// The main page's own serialized copies. Any other, a route's tree or another page's, has no row.
const OWN_PAYLOAD = /^(index|__next\._full|__next\.__PAGE__)\.txt$/;
const DEFINITION_LINK = /^\/methodology\/?#[\w-]+$/;

function hasSourceAndDefinition(block) {
  return {
    source: [...(block?.querySelectorAll("p") ?? [])].some((line) =>
      /Source:\s*[^\s·]/.test(line.textContent),
    ),
    definition: [...(block?.querySelectorAll("a[href]") ?? [])].some((link) =>
      DEFINITION_LINK.test(link.getAttribute("href")),
    ),
  };
}

// A chart with nothing in the static HTML is blank with JavaScript off, so it has to say so.
function drawsOnlyInBrowser(area) {
  return !area.textContent.trim() || area.querySelector(".recharts-responsive-container");
}

// A card's takeaway and time stay in view. Its source and definition are one tap away in the
// tooltip, and are in a plain note with JavaScript off, which the page's parser reads as elements
// here. The table is required by type, and this says it reached the page.
function checkCards(page, document, problems) {
  for (const card of document.querySelectorAll(".chart-card")) {
    const headings = [...card.querySelectorAll(".chart-card__head h2, .chart-card__head h3")];
    if (!headings.some((heading) => viewText(heading).trim())) {
      problems.push(`${page}: a card has no visible takeaway`);
    }
    const time = visibleMeta(card)?.querySelector("time[datetime]");
    if (!time?.getAttribute("datetime").trim() || !viewText(time).trim()) {
      problems.push(`${page}: a card has no visible as-of time`);
    }
    const panel = hasSourceAndDefinition(
      card.querySelector(".chart-card__head > .tip--info > .tip__panel"),
    );
    if (!panel.source) problems.push(`${page}: a card's tooltip has no source`);
    if (!panel.definition) problems.push(`${page}: a card's tooltip has no definition link`);
    const notes = [...card.querySelectorAll("noscript")].map(hasSourceAndDefinition);
    if (!notes.some((note) => note.source)) {
      problems.push(`${page}: a card's noscript note has no source`);
    }
    if (!notes.some((note) => note.definition)) {
      problems.push(`${page}: a card's noscript note has no definition link`);
    }
    if (!card.querySelector("table")) problems.push(`${page}: a card has no table`);
    for (const area of card.querySelectorAll(".chart-area")) {
      const note = area.parentElement.querySelector("noscript .chart-area__needs-js");
      if (drawsOnlyInBrowser(area) && !note) {
        problems.push(`${page}: a chart that draws only in the browser has no note for it`);
      }
    }
  }
  for (const notes of document.querySelectorAll("[data-footnotes]")) {
    if (notes.closest("noscript, .tip__panel") || notes.parentElement.closest("details")) {
      problems.push(`${page}: footnotes inside a details, noscript or tooltip`);
    }
    if (notes.hasAttribute("open"))
      problems.push(`${page}: a card's footnotes are open by default`);
  }
}

function checkLinksAndRequests(page, document, problems) {
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name)) problems.push(`${page}: an ${attribute.name} attribute`);
    }
  }
  for (const link of document.querySelectorAll("a[href], area[href]")) {
    const href = link.getAttribute("href").trim();
    if (href.startsWith("https://")) {
      const rel = (link.getAttribute("rel") ?? "").split(/\s+/);
      if (!rel.includes("noopener") || !rel.includes("noreferrer")) {
        problems.push(`${page}: an outbound link without rel="noopener noreferrer"`);
      }
    } else if (!href.startsWith("mailto:") && (HAS_SCHEME.test(href) || href.startsWith("//"))) {
      problems.push(`${page}: a link that isn't https, mailto or same-site`);
    }
  }
  for (const [tag, attribute] of REQUEST_ATTRIBUTES) {
    for (const element of document.querySelectorAll(`${tag}[${attribute}]`)) {
      const value = element.getAttribute(attribute).trim();
      if (HAS_SCHEME.test(value) || value.startsWith("//")) {
        problems.push(`${page}: a request to another host from <${tag}>`);
      }
    }
  }
}

const plainText = (element) => element?.textContent.replace(/\s+/g, " ").trim() ?? "";

// The rows are the dataset's, in its order, and each says exactly what the dataset gives and nothing
// more. A row may sit in a closed disclosure, but it can't be hidden. A chain's own rows, on its
// supply card, are held by checkPanelExchanges and named by checkPayload.
const ownRows = (document) =>
  [...document.querySelectorAll("[data-exchange-row]")].filter(
    (row) => !row.closest('[data-chain-panel]:not([data-chain-panel="all"])'),
  );

function checkExchangeRows(page, document, expected, problems) {
  const rows = ownRows(document);
  if (rows.length !== expected.exchangeRows.length) {
    problems.push(`${page}: there are ${rows.length} exchange rows`);
  }
  expected.exchangeRows.forEach(({ entity, detail, sourceHref, sourceText }, index) => {
    const row = rows[index];
    if (plainText(row?.querySelector("[data-exchange-name]")) !== entity) {
      problems.push(`${page}: exchange row ${index + 1} isn't the dataset's name`);
      return;
    }
    if ([row, ...row.querySelectorAll("*")].some(outOfView)) {
      problems.push(`${page}: the row for "${entity}" is hidden`);
    }
    if (plainText(row.querySelector("[data-exchange-detail]")) !== detail) {
      problems.push(`${page}: the row for "${entity}" isn't the dataset's figure`);
    }
    const source = row.querySelector("a[data-exchange-source]");
    if (source?.getAttribute("href") !== sourceHref || plainText(source) !== sourceText) {
      problems.push(`${page}: the row for "${entity}" hasn't the source the dataset gives`);
    }
    if (plainText(row) !== `${entity}, ${detail}. Source: ${sourceText}.`) {
      problems.push(`${page}: the row for "${entity}" says more than the dataset gives`);
    }
  });
}

// What may name an exchange in the page's serialized props: its row's own name, once.
const withoutPayloadNames = (raw, names, quote) =>
  names.reduce(
    (rest, name) =>
      rest.replace(
        `${quote}data-exchange-name${quote}:true,${quote}children${quote}:${quote}${name}${quote}`,
        "",
      ),
    raw,
  );

const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

// So a name reads as a name however it's written: an escape, a zero-width split, or a tag in it.
function readable(raw) {
  const plain = raw
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .normalize("NFKC")
    .replace(INVISIBLE, "");
  return `${plain}\n${plain.replace(/<[^>]*>/g, "")}`;
}

// Every blocked name, as a whole word and in its own case, as ordinary words are on that list. A row's
// name is distinctive, so it's found in any case and inside a longer word as well. Each row's own
// source link is the one place its host may appear.
function namesFound(raw, expected) {
  const rows = expected.exchangeRows;
  const text = rows.reduce((rest, row) => rest.replaceAll(row.sourceHref, ""), readable(raw));
  const folded = text.toLowerCase();
  const distinctive = new Set(rows.map((row) => row.entity));
  return [...new Set([...expected.blockedNames, ...distinctive])].filter(
    (name) =>
      escapedNameMatcher(name).test(text) ||
      (distinctive.has(name) && folded.includes(name.toLowerCase())),
  );
}

function checkNames(place, raw, expected, problems) {
  for (const name of namesFound(raw, expected)) problems.push(`${place}: names "${name}"`);
}

// Every row the main page writes, in its order: All's, then each chain's own on its supply card.
const everyRow = (expected) => [
  ...expected.exchangeRows,
  ...expected.supplyPanels
    .filter(({ value }) => value !== "all")
    .flatMap(({ exchanges }) => exchanges.rows),
];

// Every name is blocked, and only a row's own name is taken out first, once per row, so one
// anywhere else is still caught: the head, an attribute, a template, a sentence or serialized props.
function checkMainNames(page, html, expected, problems) {
  const names = everyRow(expected).map((row) => row.entity);
  const { document } = new JSDOM(html).window;
  for (const row of document.querySelectorAll("[data-exchange-row]")) {
    const name = row.querySelector("[data-exchange-name]");
    if (name && names.includes(name.textContent)) name.textContent = "";
  }
  const rest = withoutPayloadNames(document.documentElement.outerHTML, names, '\\"');
  checkNames(page, rest, expected, problems);
}

// The page's serialized copy, which React takes over from once it loads, so what's in it is what a
// reader ends up seeing. Each line is an id and a JSON value, and an element is ["$", type, key, props].
function flightValues(flight) {
  const values = new Map();
  for (const line of flight.split("\n")) {
    const match = /^([0-9a-f]+):(.+)$/.exec(line);
    if (!match) continue;
    try {
      values.set(match[1], JSON.parse(match[2]));
    } catch {
      // A module or hint row, which isn't JSON and holds no words.
    }
  }
  return values;
}

function flightProps(values) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      if (node[0] === "$" && typeof node[1] === "string" && node[3]) found.push(node[3]);
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  };
  values.forEach(walk);
  return found;
}

function flightText(node, values, seen = new Set()) {
  if (typeof node === "number") return String(node);
  if (typeof node === "string") {
    const reference = /^\$L?([0-9a-f]+)$/.exec(node);
    if (!reference) return node.replace(/^\$\$/, "$");
    if (seen.has(reference[1])) return "";
    seen.add(reference[1]);
    return flightText(values.get(reference[1]), values, seen);
  }
  if (!Array.isArray(node)) return "";
  if (node[0] === "$" && typeof node[1] === "string") {
    // A tooltip's panel is out of view, as in viewText. A note's words are read from inside it.
    if (node[3]?.className === "tip__panel") return "";
    return flightText(node[3]?.children, values, seen);
  }
  return node.map((child) => flightText(child, values, seen)).join("");
}

const FLIGHT_PUSH = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;

function inlineFlight(page, document, problems) {
  let flight = "";
  for (const script of document.querySelectorAll("script")) {
    for (const match of script.textContent.matchAll(FLIGHT_PUSH)) {
      try {
        flight += JSON.parse(match[1]);
      } catch {
        problems.push(`${page}: a chunk of the page's payload can't be read`);
      }
    }
  }
  return flight;
}

function flightCells(row, values) {
  const cells = Array.isArray(row.children) ? row.children : [row.children];
  return cells.map((cell) => flightText(cell, values).replace(/\s+/g, " ").trim());
}

// What a client component draws from: its rows' journey figures, as props.
function flightBandAmounts(values) {
  const found = new Map();
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      if (typeof node.key === "string" && node.journey?.placed_exchange_linked !== undefined) {
        found.set(node.key, node.journey.placed_exchange_linked);
      }
      Object.values(node).forEach(walk);
    }
  };
  values.forEach(walk);
  return found;
}

// The filter lists the dataset's chains in order, with the first chosen and nothing hiding it.
function checkFilter(page, document, expected, problems) {
  if (expected.filter.length === 0) return;
  const filter = document.querySelector('.dashboard [data-section="chain-filter"]');
  if (!filter || !inView(filter)) {
    problems.push(`${page}: the chain filter isn't in view`);
    return;
  }
  const radios = [...filter.querySelectorAll('input[type="radio"][name="chain"]')];
  const said = radios.map((input) => `${input.value}=${plainText(input.closest("label"))}`);
  const want = expected.filter.map(({ value, label }) => `${value}=${label}`);
  if (said.join() !== want.join()) {
    problems.push(
      `${page}: the chain filter lists ${said.join()}, not the dataset's ${want.join()}`,
    );
  }
  const chosen = radios.filter((input) => input.hasAttribute("checked"));
  if (chosen.length !== 1 || chosen[0] !== radios[0]) {
    problems.push(`${page}: the chain filter doesn't start on its first option`);
  }
}

const SERIES_LINES = ["Total", "Circulating", "Placed"];

const SERIES_COLUMNS = [
  { key: "day", label: "Day" },
  { key: "total", label: "Total" },
  { key: "placed", label: "Placed" },
  { key: "circulating", label: "Circulating" },
];

const panelOf = (box, value) => box?.querySelector(`:scope > [data-chain-panel="${value}"]`);

// One panel per filter option and no other, each with a card of its own.
function panelsOf(page, document, id, expected, problems) {
  const box = document.getElementById(id);
  const values = [...(box?.querySelectorAll(":scope > [data-chain-panel]") ?? [])].map(
    (panel) => panel.dataset.chainPanel,
  );
  const want = expected.filter.map(({ value }) => value);
  if (values.join() !== want.join()) {
    problems.push(`${page}: #${id} has panels for ${values.join()}, not ${want.join()}`);
  }
  return box;
}

function checkTableRows(where, table, columns, rows, problems) {
  const shown = [...(table?.querySelectorAll("tbody tr") ?? [])];
  if (shown.length !== rows.length) {
    problems.push(`${where}: its table has ${shown.length} rows, not ${rows.length}`);
    return;
  }
  rows.forEach((row, index) => {
    for (const { key, label } of columns) {
      const cell = [...shown[index].children].find((td) => td.dataset.label === label);
      if (plainText(cell) !== String(row[key])) {
        problems.push(`${where}: its table's ${label} isn't the dataset's`);
      }
    }
  });
}

// Notes about the whole card come first, on its title, then the rest in their own order, as the
// card numbers them.
const ordered = (notes) => [
  ...notes.filter((note) => !note.at),
  ...notes.filter((note) => note.at),
];

// The notes this panel holds, in order, each whole, and none for another chain, as its footnotes. A
// footnote's number is its note's place in that order, and its markers run in reading order. A note
// about the whole card has its marker on the title, and any other on the legend row, waterfall row
// or chain it qualifies. One footnote list, and one set of markers.
function checkPanelNotes(where, panel, notes, problems) {
  const want = ordered(notes);
  const cards = panel.matches(".chart-card") ? [panel] : [...panel.querySelectorAll(".chart-card")];
  const list = cards.length === 1 ? footnoteList(cards[0]) : null;
  if (want.length === 0) {
    if (panel.querySelector("[data-footnotes], a[data-fn-ref]")) {
      problems.push(`${where}: it has footnotes but no notes`);
    }
    return;
  }
  if (!list) {
    problems.push(`${where}: it has no footnotes toggle with its list`);
    return;
  }
  const items = [...list.children];
  const said = items.map((item) => `${item.dataset.note}:${item.dataset.chain ?? ""}`);
  const wanted = want.map(({ kind, chain }) => `${kind}:${chain ?? ""}`);
  if (said.join() !== wanted.join()) {
    problems.push(`${where}: its footnotes are ${said.join()}, not ${wanted.join()}`);
    return;
  }
  const markers = [...panel.querySelectorAll("a[data-fn-ref]")];
  const numbers = markers.map((marker) => Number(plainText(marker)));
  if (numbers.some((number, index) => index > 0 && number <= numbers[index - 1])) {
    problems.push(`${where}: its footnote markers aren't in reading order: ${numbers.join()}`);
  }
  want.forEach(({ kind, chain, words, tip, at }, index) => {
    const item = items[index];
    if (plainText(item.querySelector("[data-note-text]")).replace(/\s+/g, " ") !== words) {
      problems.push(`${where}: its ${kind} footnote doesn't keep its words`);
    }
    const full = item.querySelector("[data-note-full]");
    if (tip && !full?.textContent.replace(/\s+/g, " ").includes(tip)) {
      problems.push(`${where}: its ${kind} footnote has lost its words in full`);
    }
    const own = markers.filter((marker) => marker.getAttribute("href") === `#${item.id}`);
    if (own.length !== 1 || plainText(own[0]) !== String(index + 1) || !item.id) {
      problems.push(`${where}: its ${kind} footnote hasn't one marker numbered ${index + 1}`);
      return;
    }
    if (own[0].dataset.note !== kind || (own[0].dataset.chain ?? "") !== (chain ?? "")) {
      problems.push(`${where}: its ${kind} marker links to another note's footnote`);
    }
    if (!inView(own[0])) problems.push(`${where}: its ${kind} marker isn't in view`);
    const place = at
      ? own[0].closest(`[data-segment="${at}"], [data-step="${at}"], [data-velocity-chain="${at}"]`)
      : own[0].closest(".chart-card__head");
    if (!place || !panel.contains(place)) {
      problems.push(`${where}: its ${kind} marker isn't on ${at ?? "the card's title"}`);
    }
  });
  if (markers.length !== want.length) {
    problems.push(`${where}: it has ${markers.length} footnote markers for ${want.length} notes`);
  }
}

function checkPanelBar(where, panel, { key, total, parts }, problems) {
  const bar = panel.querySelector("[data-supply-bar]");
  if (!parts.some(({ amount }) => BigInt(amount) > 0n)) {
    if (bar) problems.push(`${where}: it draws a bar with no supply`);
    if (!viewText(panel).includes(UNKNOWN_TEXT)) {
      problems.push(`${where}: it doesn't say "${UNKNOWN_TEXT}"`);
    }
    return;
  }
  if (bar?.dataset.supplyBar !== key || !inView(bar)) {
    problems.push(`${where}: its bar isn't ${key}'s, in view`);
    return;
  }
  const drawn = [...bar.querySelectorAll("[data-part]")];
  const sum = drawn.reduce((held, part) => held + BigInt(part.dataset.amount ?? 0), 0n);
  if (sum.toString() !== total) {
    problems.push(`${where}: its bar's parts add up to ${sum}, not its total of ${total}`);
  }
  for (const { key: part, amount, width, band, direct } of parts) {
    const shown = drawn.find((element) => element.dataset.part === part);
    if (BigInt(amount) === 0n) {
      if (shown) problems.push(`${where}: its bar draws ${part} at zero`);
      continue;
    }
    if (shown?.dataset.amount !== amount) {
      problems.push(`${where}: its bar's ${part} isn't the dataset's`);
      continue;
    }
    if (!(shown.getAttribute("style") ?? "").replace(/\s+/g, "").includes(`flex-basis:${width}`)) {
      problems.push(`${where}: its bar's ${part} isn't drawn at its share`);
    }
    if (plainText(shown.querySelector("[data-direct-label]")) !== (direct ?? "")) {
      problems.push(`${where}: its bar's ${part} doesn't carry the dataset's label`);
    }
    const marked = shown.querySelector('[data-testid="exchange-linked-band"]');
    if (Boolean(marked) !== (band !== null && BigInt(band) > 0n)) {
      problems.push(`${where}: its ${part} band doesn't match the dataset`);
    }
  }
}

// Every segment on every panel, with what the dataset gives, so the legend can't jump or disagree.
function checkPanelLegend(where, panel, { parts }, problems) {
  const rows = [...panel.querySelectorAll("[data-supply-legend] [data-segment]")];
  const keys = parts.map(({ key }) => key);
  if (rows.map((row) => row.dataset.segment).join() !== keys.join()) {
    problems.push(`${where}: its legend doesn't list every segment`);
    return;
  }
  parts.forEach(({ key, label, compact, share, floor, bandLine }, index) => {
    const row = rows[index];
    const text = (selector) => plainText(row.querySelector(selector));
    if (!viewText(row).trim()) problems.push(`${where}: its ${key} legend row isn't in view`);
    if (text("[data-segment-label]") !== label) {
      problems.push(`${where}: its ${key} legend row doesn't say "${label}"`);
    }
    if (text("[data-segment-amount]") !== `${floor ? "≥" : ""}${compact}`) {
      problems.push(`${where}: its ${key} legend amount isn't the dataset's`);
    }
    if (text("[data-segment-share]") !== share) {
      problems.push(`${where}: its ${key} legend share isn't the dataset's`);
    }
    if (Boolean(row.querySelector('[data-coverage="floor"]')) !== floor) {
      problems.push(`${where}: its ${key} legend row has the wrong coverage mark`);
    }
    if (bandLine !== null) {
      const line = panel.querySelector(`[data-band="${key}"]`);
      if (plainText(line) !== bandLine || !viewText(line).trim()) {
        problems.push(`${where}: its ${key} band line isn't the dataset's`);
      }
    }
  });
}

function checkPanelStats(where, panel, stats, problems) {
  const shown = [...panel.querySelectorAll("[data-stat]")];
  const said = shown.map((stat) => stat.dataset.stat);
  const want = stats.map(({ key }) => key);
  // Wallets are never summed, so All shows none: this is what holds a total off the page.
  if (said.join() !== want.join()) {
    problems.push(`${where}: it shows ${said.join()} beside the bar, not ${want.join()}`);
    return;
  }
  stats.forEach(({ key, value }, index) => {
    if (viewText(shown[index].querySelector("[data-stat-value]")).trim() !== value) {
      problems.push(`${where}: its ${key} isn't the dataset's`);
    }
  });
}

// Each filter option's supply card holds what the dataset gives that chain, in view. The checks above
// read the whole page, so a panel with a wrong figure or a lost caveat would pass them.
const WALLET_TABLE_COLUMNS = [
  { key: "chain", label: "Chain" },
  { key: "clean", label: "Clean volume, 7 days" },
  { key: "wallets", label: "Active wallets, 7 days" },
];

// Held to the KPI rows, which the page's own supply code doesn't read, so a fault in that code can't
// set what this check expects. Wallets are never summed, so a panel over several chains shows no
// wallet figure outside its tooltip, footnotes and table, whatever the stats list says.
function checkPanelAgainstKpis(where, panel, want, problems) {
  const shown = panel.cloneNode(true);
  for (const hidden of shown.querySelectorAll(
    ".data-toggle, .footnotes, .tip__panel, .sr-only, noscript",
  )) {
    hidden.remove();
  }
  if (want.chains > 1 && /active wallets/i.test(shown.textContent)) {
    problems.push(`${where}: it shows a wallet figure across chains`);
  }
  const stat = (key) =>
    viewText(panel.querySelector(`[data-stat="${key}"] [data-stat-value]`)).trim();
  for (const [key, value] of Object.entries(want.fromKpis)) {
    if (stat(key) !== value) problems.push(`${where}: its ${key} disagrees with the KPI rows`);
  }
}

// Held to the dataset's own rows, which the page's supply code doesn't read, so a fault in that code
// can't set what this check expects: a chain's panel showing every chain's figures is caught here.
function checkPanelAgainstRows(where, panel, { scope, legend, band, table }, problems) {
  for (const [key, value] of Object.entries(legend)) {
    const row = panel.querySelector(`[data-supply-legend] [data-segment="${key}"]`);
    if (plainText(row?.querySelector("[data-segment-amount]")).replace("≥", "") !== value) {
      problems.push(`${where}: its ${key} legend amount isn't ${scope}'s in the dataset`);
    }
  }
  const line = panel.querySelector('[data-supply-legend] [data-band="placed_supply"]');
  if (band !== null && !plainText(line).includes(` ${band} `)) {
    problems.push(`${where}: its exchange-linked line isn't ${scope}'s in the dataset`);
  }
  const shown = [
    ...(panel.querySelector(".data-toggle table")?.querySelectorAll("tbody tr") ?? []),
  ];
  const names = shown.map((tr) => plainText(tr.querySelector('[data-label="Chain"]')));
  if (names.join() !== table.map(({ chain }) => chain).join()) {
    problems.push(`${where}: its table's chains aren't ${scope}'s, as ${names.join()}`);
    return;
  }
  table.forEach(({ chain, cells }, index) => {
    for (const [label, value] of Object.entries(cells)) {
      const cell = shown[index].querySelector(`[data-label="${label}"]`);
      if (plainText(cell) !== value) {
        problems.push(`${where}: its table's ${label} for ${chain} isn't the dataset's`);
      }
    }
  });
}

// The names under a panel's table are its own: every one across chains on All, a chain's holdings on
// a chain, which says what it leaves out rather than showing All's.
function checkPanelExchanges(where, panel, { rows, unsplit }, problems) {
  const named = [...panel.querySelectorAll(".data-toggle [data-labels-table] [data-exchange-row]")];
  const said = named.map(
    (row) =>
      `${plainText(row.querySelector("[data-exchange-name]"))}: ${plainText(row.querySelector("[data-exchange-detail]"))}`,
  );
  const want = rows.map(({ entity, detail }) => `${entity}: ${detail}`);
  if (said.join("; ") !== want.join("; ")) {
    problems.push(`${where}: its named exchanges aren't the dataset's for it`);
  }
  const note = panel.querySelector(".data-toggle [data-exchanges-unsplit]");
  if ((unsplit ?? "") !== plainText(note)) {
    problems.push(`${where}: it doesn't say which names aren't split by chain`);
  }
}

// A card per filter option, each with every chain's bar, the first over all of them, so the bars
// compare chains whichever is chosen. Its heading, legend, figures, notes and tables are the option's
// own. On a chain's card that chain's bar is marked and the others are muted.
function checkSupplyPanels(page, document, expected, problems) {
  if (expected.supplyPanels.length === 0) return;
  const id = CARD_ANCHORS.supply;
  const box = panelsOf(page, document, id, expected, problems);
  const wanted = expected.supplyPanels.map(({ value }) => value);
  for (const want of expected.supplyPanels) {
    const panel = panelOf(box, want.value);
    const where = `${page}: the ${want.value} panel of #${id}`;
    if (!panel) continue;
    if (!inView(panel)) problems.push(`${where}: it's hidden by its markup`);
    const rows = [...panel.querySelectorAll("[data-supply-row]")];
    const said = rows.map((row) => row.dataset.supplyRow);
    if (said.join() !== wanted.join()) {
      problems.push(`${where}: has bars for ${said.join()}, not ${wanted.join()}`);
    }
    for (const bar of expected.supplyPanels) {
      const row = rows.find((candidate) => candidate.dataset.supplyRow === bar.value);
      const at = `${where}, the ${bar.value} bar`;
      if (!row) continue;
      if (!inView(row)) problems.push(`${at}: it's hidden by its markup`);
      if (viewText(row.querySelector("[data-row-total]")).trim() !== bar.rowTotal) {
        problems.push(`${at}: its total isn't the dataset's`);
      }
      const mark = want.value === "all" ? "none" : bar.value === want.value ? "selected" : "muted";
      const has = row.hasAttribute("data-selected")
        ? "selected"
        : row.hasAttribute("data-muted")
          ? "muted"
          : "none";
      if (has !== mark) problems.push(`${at}: it's ${has}, not ${mark}`);
      checkPanelBar(at, row, bar, problems);
    }
    const heading = panel.querySelector(".chart-card__head h2, .chart-card__head h3");
    if (viewText(heading).trim() !== want.heading) {
      problems.push(`${where}: its heading isn't the dataset's`);
    }
    checkPanelLegend(where, panel, want, problems);
    checkPanelStats(where, panel, want.stats, problems);
    checkPanelNotes(where, panel, want.notes, problems);
    const full = panel.querySelector('.chart-card__head .tip__panel [data-full-note="placed"]');
    if (!full?.textContent.includes(want.placedNote)) {
      problems.push(`${where}: its tooltip has lost the placed note in full`);
    }
    checkPanelAgainstKpis(where, panel, want, problems);
    checkPanelAgainstRows(where, panel, want.fromRows, problems);
    const tables = panel.querySelectorAll(".data-toggle table");
    checkTableRows(where, tables[0], want.table.columns, want.table.rows, problems);
    if (
      tables.length < 2 ||
      !tables[1].querySelector("caption")?.textContent.includes(WALLETS_ACROSS_CHAINS_NOTE)
    ) {
      problems.push(`${where}: its table of wallets doesn't say what a wallet is`);
    } else {
      checkTableRows(where, tables[1], WALLET_TABLE_COLUMNS, want.kpiRows, problems);
    }
    checkPanelExchanges(where, panel, want.exchanges, problems);
  }
}

function checkSeriesPanels(page, document, expected, problems) {
  if (expected.seriesPanels.length === 0) return;
  const id = CARD_ANCHORS.series;
  const box = panelsOf(page, document, id, expected, problems);
  for (const want of expected.seriesPanels) {
    const panel = panelOf(box, want.value);
    const where = `${page}: the ${want.value} panel of #${id}`;
    if (!panel) continue;
    if (!inView(panel)) problems.push(`${where}: it's hidden by its markup`);
    const heading = panel.querySelector(".chart-card__head h2, .chart-card__head h3");
    if (viewText(heading).trim() !== want.heading) {
      problems.push(`${where}: its heading isn't the dataset's`);
    }
    checkPanelNotes(where, panel, want.notes, problems);
    const full = panel.querySelector('.tip__panel [data-full-note="series-start"]');
    if (!full?.textContent.includes(want.fullNote)) {
      problems.push(`${where}: its tooltip has lost the series note in full`);
    }
    checkTableRows(
      where,
      panel.querySelector(".data-toggle table"),
      SERIES_COLUMNS,
      want.rows,
      problems,
    );
    const lines = [...panel.querySelectorAll("[data-series-line]")].map(plainText);
    if (lines.join() !== SERIES_LINES.join()) {
      problems.push(`${where}: its legend doesn't name ${SERIES_LINES.join(", ")}`);
    }
  }
}

// Each waterfall part summed straight from the rows, from Day 0, with no code the page uses, so a
// fault in the panel code can't set what the check expects.
const DAY_ZERO_TEXT = "2026-09-30";
const PART_FIELDS = [
  "headline_value",
  "minted",
  "burned",
  "fees",
  "fee_liquidity",
  "issuer_flows",
  "same_entity",
  "same_tx_netting",
  "dex_flow",
  "lending_flow",
  "clean_large",
  "clean_everyday",
];
function sumsFromRows(rows, chains) {
  const sums = Object.fromEntries(PART_FIELDS.map((field) => [field, 0n]));
  for (const row of rows) {
    if (row.day < DAY_ZERO_TEXT || !chains.includes(row.chain)) continue;
    for (const field of PART_FIELDS) sums[field] += BigInt(row[field]);
  }
  return Object.fromEntries(Object.entries(sums).map(([key, sum]) => [key, sum.toString()]));
}

// What the velocity chart must print, worked out here from the KPI rows with no code the chart uses,
// so a fault in its scale or its order can't set what this check expects: chains in the site's
// order, three measures each, on one linear scale from zero to the largest figure.
const VELOCITY_FIELDS = ["velocity_bps", "velocity_everyday_bps", "headline_velocity_bps"];
function velocityExpected(kpis, warnings) {
  const order = Object.keys(CHAIN_NAMES);
  const rows = [...kpis].sort((a, b) => order.indexOf(a.chain) - order.indexOf(b.chain));
  const values = rows
    .flatMap((row) => VELOCITY_FIELDS.map((field) => row[field]))
    .filter((v) => v !== null);
  const max = values.length > 0 ? Math.max(...values) : null;
  const width = (bps) =>
    bps === null || max === null
      ? null
      : max === 0
        ? 0
        : Number((BigInt(bps) * 10_000n) / BigInt(max));
  const chart = velocityChart(kpis, warnings);
  return {
    heading: velocityHeading(kpis),
    bars:
      max === null
        ? []
        : rows.flatMap((row) =>
            VELOCITY_FIELDS.map(
              (field) =>
                `${row.chain}:${field}=${row[field] === null ? UNKNOWN_TEXT : formatBps(row[field])}@${width(row[field])}`,
            ),
          ),
    notes: chart.notes.map(({ kind, chain, text, tip }) => ({
      kind,
      chain,
      words: text,
      tip,
      at: chart.max === null ? undefined : chain,
    })),
    fullWarnings: chart.fullWarnings,
  };
}

// What the chain grid must print, worked out here from the chain roles rows: a bar scales to the
// amount a lead is measured on (publish.py's _LEADING_MEASURES), and the lead marker is the dataset's.
const GRID_FIELDS = [
  { measure: "supply", amount: "total_supply", share: "supply_share_bps", showAmount: false },
  { measure: "issuance", amount: "minted_30d", share: "", showAmount: true },
  {
    measure: "everyday",
    amount: "clean_everyday_30d",
    share: "clean_everyday_share_bps",
    showAmount: true,
  },
  { measure: "dex_flow", amount: "dex_flow_30d", share: "dex_flow_share_bps", showAmount: true },
  { measure: "lending_flow", amount: "lending_flow_30d", share: "", showAmount: true },
];
function gridExpected(roles) {
  const order = Object.keys(CHAIN_NAMES);
  const rows = [...roles].sort((a, b) => order.indexOf(a.chain) - order.indexOf(b.chain));
  return {
    rows: GRID_FIELDS.map(({ measure, amount, share, showAmount }) => {
      const amounts = rows.map((row) => BigInt(row[amount]));
      const largest = amounts.reduce((top, value) => (value > top ? value : top), 0n);
      return {
        measure,
        cells: rows.map((row, index) => {
          const shared = share ? formatBps(row[share]) : "";
          return {
            chain: row.chain,
            text: showAmount
              ? `${formatCompact(amounts[index])}${shared ? ` (${shared})` : ""}`
              : shared,
            widthBps:
              largest > 0n && amounts[index] > 0n
                ? Number((amounts[index] * 10_000n) / largest)
                : 0,
            leads: row.leading_for.includes(measure),
          };
        }),
      };
    }),
  };
}

// Velocity by chain: each bar's figure and width, each warning's pin beside its own chain and
// nowhere else, the notes in view with their words, each warning whole in the tooltip, and the
// wallet counts' caveat in the caption of the table that holds them.
function checkVelocity(page, document, expected, problems) {
  if (!expected.velocity) return;
  const card = document.querySelector(`[id="${CARD_ANCHORS.velocity}"]`);
  const where = `${page}: #${CARD_ANCHORS.velocity}`;
  if (!card) {
    problems.push(`${where}: missing`);
    return;
  }
  const want = expected.velocity;
  checkHeadingOf(where, card, want.heading, problems);
  const bars = [...card.querySelectorAll("[data-velocity-chain] [data-measure]")].map((row) => {
    const chain = row.closest("[data-velocity-chain]").dataset.velocityChain;
    const bar = row.querySelector(".velocity-chart__bar");
    const width = bar ? Number(bar.dataset.width) : null;
    const value = viewText(row.querySelector("[data-velocity-value]")).trim();
    return `${chain}:${row.dataset.measure}=${value}@${width}`;
  });
  // A bar of zero width draws nothing, as one with no figure does.
  const drawn = want.bars.map((bar) => bar.replace(/@0$/, "@null"));
  if (bars.join() !== drawn.join()) problems.push(`${where}: its bars aren't the dataset's`);
  checkPanelNotes(where, card, want.notes, problems);
  for (const [kind, words] of [
    ["velocity-denominators", VELOCITY_NOTE],
    ["velocity-jumpy", JUMPY_NOTE],
  ]) {
    const full = card.querySelector(`.tip__panel [data-full-note="${kind}"]`);
    if (!full?.textContent.includes(words)) {
      problems.push(`${where}: its tooltip has lost the ${kind} note in full`);
    }
  }
  for (const { chain, text } of want.fullWarnings) {
    const full = card.querySelector(
      `.tip__panel [data-full-note="velocity-warning"][data-chain="${chain}"]`,
    );
    if (plainText(full) !== text)
      problems.push(`${where}: its tooltip has lost ${chain}'s warning`);
  }
  const caption = card.querySelector(".data-toggle table caption");
  if (!caption?.textContent.includes(WALLETS_NOTE)) {
    problems.push(`${where}: its table of wallets doesn't say what a wallet is`);
  }
}

// The chain grid: a real table in view, each cell's figure, bar width and lead marker as the dataset
// gives them, and the as-of row only when the chains' days differ.
function checkGrid(page, document, expected, problems) {
  if (!expected.grid) return;
  const card = document.querySelector(`[id="${CARD_ANCHORS.chainRoles}"]`);
  const where = `${page}: #${CARD_ANCHORS.chainRoles}`;
  const grid = card?.querySelector("table[data-chain-grid]");
  if (!grid || !inView(grid) || grid.closest("[aria-hidden], details, noscript")) {
    problems.push(`${where}: its grid isn't in view`);
    return;
  }
  const said = [...grid.querySelectorAll("tbody tr[data-grid-measure]")]
    .filter((row) => row.dataset.gridMeasure !== "as-of")
    .flatMap((row) =>
      [...row.querySelectorAll("td[data-grid-chain]")].map(
        (cell) =>
          `${row.dataset.gridMeasure}:${cell.dataset.gridChain}=${viewText(cell.querySelector("[data-grid-value]"), "").replace(/\s+/g, " ").trim()}@${cell.querySelector(".chain-grid__bar")?.dataset.width}${cell.hasAttribute("data-leads") ? "*" : ""}`,
      ),
    );
  const want = expected.grid.rows.flatMap((row) =>
    row.cells.map(
      (cell) =>
        `${row.measure}:${cell.chain}=${cell.text}@${cell.widthBps}${cell.leads ? "*" : ""}`,
    ),
  );
  if (said.join() !== want.join()) problems.push(`${where}: its grid isn't the dataset's`);
}

// The full notes a card's tooltip must hold, by kind.
function checkFullNotes(where, panel, fullNotes, problems) {
  for (const [kind, text] of Object.entries(fullNotes)) {
    const full = panel.querySelector(`.tip__panel [data-full-note="${kind}"]`);
    if (plainText(full) !== text)
      problems.push(`${where}: its tooltip has lost the ${kind} note in full`);
  }
}

function checkHeadingOf(where, panel, heading, problems) {
  const shown = panel.querySelector(".chart-card__head h2, .chart-card__head h3");
  if (viewText(shown).trim() !== heading)
    problems.push(`${where}: its heading isn't the dataset's`);
}

// Each filter option's waterfall: its rows in order with their figures, each pin on its row with its
// note's number, its notes, the notes in full and both tables.
function checkWaterfallPanels(page, document, expected, problems) {
  if (expected.waterfallPanels.length === 0) return;
  const id = CARD_ANCHORS.waterfall;
  const box = panelsOf(page, document, id, expected, problems);
  for (const want of expected.waterfallPanels) {
    const panel = panelOf(box, want.value);
    const where = `${page}: the ${want.value} panel of #${id}`;
    if (!panel) continue;
    if (!inView(panel)) problems.push(`${where}: it's hidden by its markup`);
    checkHeadingOf(where, panel, want.heading, problems);
    const rows = [...panel.querySelectorAll(".chart-area [data-step]")];
    const said = rows.map(
      (row) => `${row.dataset.step}=${viewText(row.querySelector(".tabular-nums"), "").trim()}`,
    );
    const wanted = want.steps.map(({ key, figure }) => `${key}=${figure}`);
    if (said.join() !== wanted.join()) {
      problems.push(`${where}: its rows aren't the dataset's`);
    }
    // The same figures from the rows themselves. The amount sits after the sign, if any.
    for (const row of rows) {
      const sum = want.sums[row.dataset.step];
      const shown = viewText(row.querySelector(".tabular-nums"), "")
        .trim()
        .replace(/^\u2212/, "");
      if (sum !== undefined && shown !== formatCompact(sum)) {
        problems.push(`${where}: its ${row.dataset.step} isn't the rows' own sum`);
      }
    }
    checkPanelNotes(where, panel, want.notes, problems);
    checkFullNotes(where, panel, want.fullNotes, problems);
    const tables = panel.querySelectorAll(".data-toggle table");
    checkTableRows(where, tables[0], STEP_COLUMNS, want.stepRows, problems);
    checkTableRows(where, tables[1], PERIOD_COLUMNS, want.periodRows, problems);
  }
}

// Each filter option's weekly bars: a bar per week with its figure and end date, the same weeks
// under every option, its notes and its table.
function checkWeeklyPanels(page, document, expected, problems) {
  if (expected.weeklyPanels.length === 0) return;
  // A chain's weeks are All's weeks, and on a complete dataset they add up to All's, whatever code
  // drew them.
  const [all, ...chains] = expected.weeklyPanels;
  if (all && chains.length > 0) {
    all.amounts.forEach((amount, index) => {
      const sum = chains.reduce((total, chain) => total + BigInt(chain.amounts[index] ?? "0"), 0n);
      if (
        chains.some((chain) => chain.amounts.length !== all.amounts.length) ||
        sum !== BigInt(amount)
      ) {
        problems.push(`${page}: the chains' weeks don't add up to All's`);
      }
    });
  }
  const id = CARD_ANCHORS.weekly;
  const box = panelsOf(page, document, id, expected, problems);
  for (const want of expected.weeklyPanels) {
    const panel = panelOf(box, want.value);
    const where = `${page}: the ${want.value} panel of #${id}`;
    if (!panel) continue;
    if (!inView(panel)) problems.push(`${where}: it's hidden by its markup`);
    checkHeadingOf(where, panel, want.heading, problems);
    const bars = [...panel.querySelectorAll(".chart-area [data-week]")].map(
      (bar) => `${bar.dataset.week}=${viewText(bar.querySelector("[data-week-value]"), "").trim()}`,
    );
    if (bars.join() !== want.bars.join()) problems.push(`${where}: its bars aren't the dataset's`);
    checkPanelNotes(where, panel, want.notes, problems);
    checkFullNotes(where, panel, want.fullNotes, problems);
    checkTableRows(
      where,
      panel.querySelector(".data-toggle table"),
      WEEK_COLUMNS,
      want.rows,
      problems,
    );
  }
}

// The same rows, caveats and band as the HTML, or the page changes under a reader once it loads. No
// elements to read is a failure, or a payload this check can't follow would turn the check off.
function checkPayload(place, flight, expected, problems) {
  const values = flightValues(flight);
  const props = flightProps(values);
  if (props.length === 0) {
    problems.push(`${place}: the page's payload can't be read`);
    return;
  }
  const words = (element) => flightText(element.children, values).replace(/\s+/g, " ").trim();
  const rows = props.filter((element) => element["data-exchange-row"]);
  const want = everyRow(expected);
  if (rows.length !== want.length) {
    problems.push(`${place}: the payload has ${rows.length} exchange rows`);
  }
  want.forEach(({ entity, detail, sourceHref, sourceText }, index) => {
    const row = rows[index];
    if (!row || words(row) !== `${entity}, ${detail}. Source: ${sourceText}.`) {
      problems.push(`${place}: the payload's row for "${entity}" isn't the dataset's`);
      return;
    }
    const inRow = flightProps(new Map([["row", row.children]]));
    if (inRow.find((element) => element["data-exchange-source"])?.href !== sourceHref) {
      problems.push(`${place}: the payload's row for "${entity}" hasn't the dataset's source`);
    }
  });
  for (const { kind, chain, text, exact } of expected.essentialNotes) {
    const shown = props
      .filter(
        (element) => element["data-note"] === kind && (!chain || element["data-chain"] === chain),
      )
      // A note's words are in its badge's tooltip, in the element that holds them.
      .map((element) => {
        const inNote = flightProps(new Map([["note", element.children]]));
        const held = inNote.find((child) => child["data-note-text"] !== undefined);
        return held ? words(held) : "";
      });
    if (!shown.some((said) => (exact ? said === text : said.includes(text)))) {
      problems.push(`${place}: the payload's ${kind} note isn't the dataset's`);
    }
  }
  const amounts = flightBandAmounts(values);
  const rowsOfCells = props
    .filter((element) => element.children !== undefined)
    .map((element) => flightCells(element, values));
  for (const { key, name, amount, exact } of expected.bands) {
    if (amounts.get(key) !== amount) {
      problems.push(
        `${place}: the payload's exchange-linked amount for ${key} isn't the dataset's`,
      );
    }
    if (key !== "all" && !rowsOfCells.some((cells) => cells[0] === name && cells.includes(exact))) {
      problems.push(`${place}: the payload's table has another exchange-linked amount for ${key}`);
    }
  }
}

// The band's line in the supply card's legend, which is the first option's, and each chain's in the
// table, as the dataset gives them.
function checkBands(page, document, expected, problems) {
  const lines = [...document.querySelectorAll("[data-exchange-linked]")];
  // Each option's card has its own legend, so each band above zero has its line, on its own card.
  const drawn = expected.bands.filter(({ amount }) => BigInt(amount) > 0n);
  if (lines.length !== drawn.length) {
    problems.push(`${page}: there are ${lines.length} exchange-linked lines`);
  }
  for (const { key, line } of drawn) {
    const shown = lines.find((element) => element.dataset.exchangeLinked === key);
    if (plainText(shown) !== line) {
      problems.push(`${page}: the exchange-linked line for ${key} isn't the dataset's`);
    }
  }
  const tableRows = [...document.querySelectorAll("tr")].map((row) =>
    [...row.children].map(plainText),
  );
  for (const { key, name, exact } of expected.bands) {
    if (key !== "all" && !tableRows.some((cells) => cells[0] === name && cells.includes(exact))) {
      problems.push(`${page}: the table has another exchange-linked amount for ${key}`);
    }
  }
}

// Allowed only in the labels table, in the legend (its words are the labels file's own and carry
// a label's source rule), or as the whole words of a link to the named party's own site.
const SOURCE_SITES = {
  Coinbase: "coinbase.com",
  Crystal: "crystalintelligence.com",
  Kraken: "kraken.com",
};

function ownSourceLink(link, name) {
  const site = SOURCE_SITES[name];
  if (!site || plainText(link) !== name) return false;
  const host = new URL(link.getAttribute("href")).hostname;
  return host === site || host.endsWith(`.${site}`);
}

function checkMethodologyNames(page, html, expected, problems) {
  const { document } = new JSDOM(html).window;
  for (const allowed of document.querySelectorAll(
    "script, style, template, [data-labels-table], [data-source-legend]",
  )) {
    allowed.remove();
  }
  for (const link of document.querySelectorAll('a[href^="https://"]')) {
    if (Object.keys(SOURCE_SITES).some((name) => ownSourceLink(link, name))) link.remove();
  }
  for (const name of namesFound(document.body.innerHTML, expected)) {
    problems.push(`${page}: names "${name}" with no source beside it`);
  }
}

function checkEveryFile(path, content, expected, problems) {
  const candidates = [content];
  if (path.endsWith(".html")) {
    candidates.push(new JSDOM(content).window.document.documentElement.textContent);
  }
  for (const text of candidates) {
    for (const secret of expected.pipelineStrings) {
      if (secret.length < MIN_PIPELINE_STRING) continue;
      const serialized = JSON.stringify(secret).slice(1, -1);
      if (text.includes(secret) || text.includes(serialized)) {
        problems.push(`${path}: holds a pipeline string that isn't reader copy`);
      }
    }
  }
  if (content.includes("_RPC_URL")) problems.push(`${path}: holds an RPC variable's name`);
  if (expected.frameWord && content.includes(FRESH_SENTENCE)) {
    problems.push(`${path}: holds "${FRESH_SENTENCE}" on non-real data`);
  } else if (expected.freshness === "stale" && content.includes(FRESH_SENTENCE)) {
    problems.push(`${path}: holds "${FRESH_SENTENCE}" on stale data`);
  }
  if (path.endsWith(".css") && CSS_REQUEST.test(content)) {
    problems.push(`${path}: a request to another host from CSS`);
  }
}

// Returns every problem found. An empty list is a pass.
export function verifyOutput(outDir, expected) {
  const problems = [];
  const files = filesUnder(outDir);
  const pages = files.filter((path) => path.endsWith(".html"));
  const allowedAddresses = new Set(Object.values(expected.tokenContracts));
  for (const page of ["index.html", "methodology/index.html", "reconciliation/index.html"]) {
    if (!files.includes(join(outDir, page))) problems.push(`${page}: missing`);
  }
  for (const path of pages) {
    const page = relative(outDir, path);
    const html = readFileSync(path, "utf8");
    const { document } = new JSDOM(html).window;
    const nodes = allTextNodes(document);
    const text = nodes.map((node) => node.data).join(" ");
    checkEveryPage(page, document, problems);
    checkFooterStatus(page, document, expected, problems);
    checkTooltips(page, document, problems);
    checkStateOnPage(page, document, expected, problems);
    checkFreshnessOnPage(page, document, expected, problems);
    checkCards(page, document, problems);
    checkLinksAndRequests(page, document, problems);
    if (page === "methodology/index.html") {
      // A named label's link may hold its own address, so here it's what a reader sees.
      const seen = [document.title, ...nodes.map((node) => node.data)];
      checkAddresses(page, seen, allowedAddresses, problems);
      checkMethodologyNames(page, html, expected, problems);
    } else {
      // No page but the methodology has a reason to hold one, seen or serialized.
      checkAddresses(page, [html, text], new Set(), problems);
      if (page === "index.html") {
        checkMainNames(page, html, expected, problems);
      } else {
        checkNames(page, document.documentElement.outerHTML, expected, problems);
      }
    }
    if (page === "reconciliation/index.html") {
      checkReconciliationPage(page, document, expected, problems);
    }
    if (page === "index.html") {
      checkMainFrame(page, document, expected, problems);
      checkMainFreshness(page, document, expected, problems);
      checkHeadline(page, document, expected, problems);
      checkKpiRow(page, document, expected, problems);
      checkNoPushDown(page, document, problems);
      checkEssentialNotes(page, document, expected, problems);
      checkExchangeRows(page, document, expected, problems);
      checkBands(page, document, expected, problems);
      checkFilter(page, document, expected, problems);
      checkSupplyPanels(page, document, expected, problems);
      checkSeriesPanels(page, document, expected, problems);
      checkWaterfallPanels(page, document, expected, problems);
      checkWeeklyPanels(page, document, expected, problems);
      checkVelocity(page, document, expected, problems);
      checkGrid(page, document, expected, problems);
      checkPayload(page, inlineFlight(page, document, problems), expected, problems);
    }
  }
  for (const path of files) {
    if (BINARY_EXTENSIONS.has(extname(path))) continue;
    const content = readFileSync(path, "utf8");
    const name = relative(outDir, path);
    checkEveryFile(name, content, expected, problems);
    // Serialized props, as a name or address in them is on its way to the reader.
    if (name.endsWith(".txt") && !name.startsWith(`methodology${sep}`)) {
      const own = OWN_PAYLOAD.test(name);
      const names = own ? everyRow(expected).map((row) => row.entity) : [];
      checkNames(name, withoutPayloadNames(content, names, '"'), expected, problems);
      if (own) checkPayload(name, content, expected, problems);
      checkAddresses(name, [content], new Set(), problems);
    }
  }
  return problems;
}

// What the page must keep in view and what each says, from the same conditions and words the views
// use to show it. A kind on two cards is two instances, and each is required.
function essentialNotes({ manifest, summary, journey, activity }) {
  const { definitions } = manifest;
  const rows = activity.data;
  const scope = day0Scope(rows, summary.kpis);
  return [
    { kind: "placed", text: PLACED_PIN, exact: true },
    { kind: "exchange-floor", text: EXCHANGE_FLOOR_PIN, exact: true },
    { kind: "series-start", text: seriesStartPin(definitions), exact: true },
    { kind: "small-ticket", text: SMALL_TICKET_PIN, exact: true },
    { kind: "everyday-meaning", text: everydayNote(definitions), exact: true },
    { kind: "velocity-denominators", text: VELOCITY_PIN, exact: true },
    { kind: "no-swaps", text: NO_SWAPS_NOTE },
    // On the supply card, whose wallet counts are in its tables. The velocity table's caption says it
    // there too, which checkVelocity holds.
    { kind: "wallets-not-people", text: WALLETS_NOTE, exact: true },
    ...(waterfall(rows) ? [{ kind: "hops", text: HOPS_NOTE, exact: true }] : []),
    ...(scope ? [{ kind: "day-0-scope", text: day0Pin(scope), exact: true }] : []),
    ...(weeklyEveryday(rows).length > 0
      ? [{ kind: "history", text: historyPin(historyLabel(rows)), exact: true }]
      : []),
    ...velocityWarnings(manifest.warnings)
      .filter(({ chain }) => summary.kpis.some((row) => row.chain === chain))
      .map(({ chain, pin }) => ({ kind: "velocity-warning", chain, text: pin, exact: true })),
    ...newestByChain(journey.data)
      .filter((row) => !row.issuer_labeled && BigInt(row.issuer_inventory) === 0n)
      .map(({ chain }) => ({
        kind: "issuer-unlabeled",
        chain,
        text: issuerUnlabeledNote(chain),
      })),
    ...newestByChain(journey.data)
      .filter((row) => BigInt(row.venue_exchange) === 0n)
      .map(({ chain }) => ({
        kind: "exchange-coverage",
        chain,
        text: exchangeCoveragePin(chain),
        exact: true,
      })),
  ];
}

// What the supply card's figures and wallet table must be, read straight from the KPI rows. Circulating
// is compared only when each chain's KPI row is from its newest journey day, as the card reads that day.
function kpiFigures(option, kpis, journey) {
  const own = newestByChain(kpis).filter((row) => option.chains.includes(row.chain));
  const days = new Map(newestByChain(journey).map((row) => [row.chain, row.day]));
  const sameDays = own.every((row) => days.get(row.chain) === row.day);
  const all = own.length > 0 ? allChainKpis(own) : null;
  return {
    fromKpis: {
      "clean-7d": formatCompact(all?.clean_7d),
      ...(sameDays ? { circulating: formatCompact(all?.circulating_supply) } : {}),
      ...(option.chains.length === 1
        ? { "active-wallets": own[0]?.active_wallets_7d.toLocaleString("en-US") ?? UNKNOWN_TEXT }
        : {}),
    },
    kpiRows: own.map((row) => ({
      chain: CHAIN_NAMES[row.chain],
      clean: `${formatCompact(row.clean_7d)} (${formatExact(row.clean_7d)})`,
      wallets: row.active_wallets_7d.toLocaleString("en-US"),
    })),
  };
}

// The supply parts a row holds, by the names the legend and table give them, read straight from the
// dataset so they don't depend on the page's supply code. Exchange venues are a floor.
const ROW_PARTS = [
  ["issuer_inventory", "Issuer inventory"],
  ["placed_supply", "Placed"],
  ["placed_exchange_linked", "Of placed, exchange-linked"],
  ["venue_dex", "DEX venues"],
  ["venue_lending", "Lending venues"],
  ["venue_exchange", "Exchange venues, at least"],
  ["free_floating", "Free-floating"],
];

// What an option's legend and table must say, from each chain's newest journey row as written:
// summed over every chain on All, and one chain's own on a chain.
function rowFigures(option, journey) {
  const rows = newestByChain(journey).filter((row) => option.chains.includes(row.chain));
  const sum = (key) => rows.reduce((held, row) => held + BigInt(row[key]), 0n).toString();
  const legend = Object.fromEntries(
    ROW_PARTS.filter(([key]) => key !== "placed_exchange_linked").map(([key]) => [
      key,
      key === "venue_exchange" ? formatFloorDollars(sum(key)) : formatCompact(sum(key)),
    ]),
  );
  return {
    scope: option.value === "all" ? "every chain" : CHAIN_NAMES[option.value],
    legend: rows.length > 0 ? legend : {},
    band: rows.length > 0 ? formatCompact(sum("placed_exchange_linked")) : null,
    table: rows.map((row) => ({
      chain: CHAIN_NAMES[row.chain],
      cells: Object.fromEntries([
        ["Total", formatExact(row.total_supply)],
        ...ROW_PARTS.map(([key, label]) => [label, formatExact(row[key])]),
      ]),
    })),
  };
}

// What each filter option's supply card and step line must say, from the same functions the view uses.
function expectedPanels(files) {
  const { manifest, summary, journey, activity, labels } = files;
  const options = chainOptions(manifest.coverage.chains_included);
  const inputs = {
    journey: journey.data,
    activity: activity.data,
    kpis: summary.kpis,
    definitions: manifest.definitions,
    exchanges: exchangeRows(labels),
    chainExchanges: Object.fromEntries(
      manifest.coverage.chains_included.map((chain) => [chain, chainExchangeRows(labels, chain)]),
    ),
  };
  const activityInputs = {
    activity: activity.data,
    kpis: summary.kpis,
    definitions: manifest.definitions,
  };
  // The words in view, and the note in full in its tooltip, with its link's words after it.
  const noteWordsOf = ({ kind, chain, text, tip, link, segment }) => ({
    kind,
    chain,
    at: segment,
    words: text,
    ...(tip ? { tip: link ? `${tip} ${link.text}.` : tip } : {}),
  });
  return {
    filter: options.map(({ value, label }) => ({ value, label })),
    supplyPanels: options.map((option) => {
      const panel = supplyPanel(option, inputs);
      // With no legend, a segment's note has no row, so its badge is by the title.
      const notes = panel.notes
        .map(noteWordsOf)
        .map((note) => (panel.bar ? note : { ...note, at: undefined }));
      return {
        value: option.value,
        heading: panel.heading,
        key: panel.bar?.key ?? null,
        total: panel.bar?.journey.total_supply ?? null,
        rowTotal: panel.bar ? formatCompact(panel.bar.journey.total_supply) : UNKNOWN_TEXT,
        parts: panel.segments.map((segment) => ({
          key: segment.key,
          label: segmentLabel(segment),
          amount: segment.amount,
          compact: legendAmount(segment),
          width: `${(segment.shareBps ?? 0) / 100}%`,
          share: formatBps(segment.shareBps),
          direct: directLabel(segment),
          floor: segment.coverage === "floor",
          band: segment.band?.amount ?? null,
          bandLine: segment.band?.line ?? null,
        })),
        stats: panel.stats,
        notes,
        table: panel.table,
        chains: option.chains.length,
        ...kpiFigures(option, summary.kpis, journey.data),
        placedNote: PLACED_NOTE,
        exchanges: panel.exchanges,
        fromRows: rowFigures(option, journey.data),
      };
    }),
    velocity: velocityExpected(summary.kpis, manifest.warnings),
    grid: gridExpected(files.chain_roles.data),
    waterfallPanels: options.map((option) => {
      const panel = waterfallPanel(option, activityInputs);
      return {
        value: option.value,
        sums: sumsFromRows(activity.data, option.chains),
        heading: panel.heading,
        steps: (panel.waterfall?.steps ?? []).map((step) => ({
          key: step.key,
          figure: stepFigure(step),
        })),
        notes: panel.notes.map(({ kind, text, step }) => ({ kind, words: text, at: step })),
        fullNotes: panel.fullNotes,
        stepRows: panel.steps.rows,
        periodRows: panel.periods.rows,
      };
    }),
    weeklyPanels: options.map((option) => {
      const panel = weeklyPanel(option, activityInputs);
      return {
        value: option.value,
        heading: panel.heading,
        bars: panel.weeks.map((week) => `${week.to}=${formatCompact(week.everyday)}`),
        amounts: panel.weeks.map((week) => week.everyday),
        notes: panel.notes.map(({ kind, text }) => ({ kind, words: text })),
        fullNotes: panel.fullNotes,
        rows: panel.table.rows,
      };
    }),
    seriesPanels: options.map((option) => {
      const panel = seriesPanel(option, inputs);
      return {
        value: option.value,
        heading: panel.heading,
        notes: panel.notes.map(noteWordsOf),
        fullNote: seriesStartNote(manifest.definitions),
        rows: panel.tableRows,
      };
    }),
  };
}

// In the row's order, with the same formats, so a value is held to the dataset too.
function expectedKpiValues(kpis) {
  const figures = allChainKpis(kpis);
  if (!figures) return Array(KPIS).fill(UNKNOWN_TEXT);
  return [
    formatCompact(figures.total_supply),
    formatBps(figures.placed_share_bps),
    formatCompact(figures.clean_everyday_7d),
    formatBps(figures.velocity_everyday_bps),
  ];
}

export function expectedFromDataset(location, webRoot = process.cwd(), now = Date.now()) {
  const { files, placement } = loadDatasetFiles(location, webRoot);
  return expectedFromFiles(files, placement, webRoot, now);
}

export function expectedFromFiles(files, placement, webRoot = process.cwd(), now = Date.now()) {
  const state = deriveState(files, placement, now);
  const {
    kind,
    frameWord,
    freshness,
    asOfLine,
    trustLine,
    passing,
    headStale,
    staleInFooter,
    runLine,
  } = state;
  const { manifest, summary } = files;
  const { verdict } = summary;
  return {
    kind,
    frameWord,
    freshness,
    asOfLine,
    trustLine,
    passing,
    headStale,
    staleInFooter,
    runLine,
    checkCount: files.manifest.checks.length,
    version: manifest.dataset_version,
    pipelineStrings: [
      ...manifest.checks.map((check) => check.detail),
      ...(manifest.stale_reason ? [manifest.stale_reason] : []),
    ],
    blockedNames: JSON.parse(readFileSync(join(webRoot, "scripts/blocked-names.json"), "utf8")),
    tokenContracts: TOKEN_CONTRACTS,
    verdict: {
      sentence: verdictSentence(verdict),
      text: verdict.text,
      textVisible: verdictTextVisible(verdict, state),
      items: [...verdict.facts, ...verdict.estimates, ...verdict.opinions],
    },
    // Named under the row only when a chain is missing.
    kpiScope: REQUIRED_CHAINS.every((chain) => summary.kpis.some((row) => row.chain === chain))
      ? null
      : `Across ${summary.kpis.map((row) => CHAIN_NAMES[row.chain]).join(", ")}.`,
    kpiValues: expectedKpiValues(summary.kpis),
    essentialNotes: essentialNotes(files),
    exchangeRows: exchangeRows(files.labels),
    ...expectedPanels(files),
    bands: exchangeLinkedBands(files.journey.data).map((band) => ({
      ...band,
      name: CHAIN_NAMES[band.key] ?? band.key,
      exact: formatExact(band.amount),
    })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = verifyOutput(process.argv[2], expectedFromDataset(locateDataset()));
  for (const problem of problems) console.error(problem);
  process.exit(problems.length > 0 ? 1 : 0);
}
