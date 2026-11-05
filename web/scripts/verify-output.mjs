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
import { CARD_ANCHORS, CHAIN_NAMES, TOKEN_CONTRACTS } from "../lib/definitions.ts";
import { exchangeRows } from "../lib/exchange-rows.ts";
import { formatBps, formatCompact, formatExact, UNKNOWN_TEXT } from "../lib/format.ts";
import {
  activityChains,
  day0Scope,
  historyLabel,
  stepFigure,
  velocityHeading,
  velocityWarnings,
  waterfall,
  waterfallHeading,
  weeklyEveryday,
  weeklyHeading,
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
  EXCHANGE_FLOOR_LINK,
  EXCHANGE_FLOOR_NOTE,
  exchangeCoverageNote,
  historyPin,
  HOPS_NOTE,
  issuerUnlabeledNote,
  NO_SWAPS_NOTE,
  PLACED_NOTE,
  PLACED_PIN,
  seriesStartNote,
  seriesStartPin,
  SMALL_TICKET_PIN,
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
import { chainRolesHeading } from "../lib/takeaways/chain-roles.ts";
import { chainGrid, velocityChart } from "../lib/chain-views.ts";
import { exchangeLinkedBands, journeyHeading } from "../lib/takeaways/journey.ts";
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

function checkEveryPage(page, document, problems) {
  const header = viewText(document.querySelector("header"));
  const footer = viewText(document.querySelector("footer"));
  if (!header.includes(INDEPENDENCE_LINE)) {
    problems.push(`${page}: no independence line in the header`);
  }
  if (!footer.includes(INDEPENDENCE_LINE)) {
    problems.push(`${page}: no independence line in the footer`);
  }
  if (!/not financial advice/i.test(footer)) problems.push(`${page}: no "not financial advice"`);
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

// Every page says when its data is out of date. The note is there while fresh too, for the clock.
function checkFreshnessOnPage(page, document, expected, problems) {
  const shown = document.documentElement.dataset.freshness;
  if (shown !== "fresh" && shown !== "stale") {
    problems.push(`${page}: no freshness on the page root`);
  } else if (expected.freshness === "stale" && shown !== "stale") {
    problems.push(`${page}: page root says fresh, dataset is stale`);
  }
  const note = viewText(document.querySelector("[data-stale-note]"));
  if (!note.includes(expected.asOfLine.stale)) problems.push(`${page}: no stale note`);
}

function checkMainFreshness(page, document, expected, problems) {
  const shownFresh = document.documentElement.dataset.freshness === "fresh";
  const verdict = viewText(document.querySelector('[data-section="verdict"]'));
  const trust = viewText(document.querySelector('[data-section="trust-strip"]'));
  if (!verdict.includes(expected.asOfLine.stale)) {
    problems.push(`${page}: the verdict block has no stale text`);
  }
  if (shownFresh && expected.asOfLine.fresh && !verdict.includes(expected.asOfLine.fresh)) {
    problems.push(`${page}: the verdict block has no fresh text`);
  }
  // On sample or preview data the strip's own check, below, covers both.
  if (expected.frameWord) return;
  if (!trust.includes(expected.trustLine.stale)) {
    problems.push(`${page}: the trust strip has no stale text`);
  }
  if (shownFresh && expected.trustLine.fresh && !trust.includes(expected.trustLine.fresh)) {
    problems.push(`${page}: the trust strip has no fresh text`);
  }
}

// Only the verdict's chip. The words "Our reading" are fine in an accordion's heading, or in the
// methodology page's table of what each chip means.
function checkMainFrame(page, document, expected, problems) {
  const word = expected.frameWord;
  if (!word) return;
  const chip = document.querySelector('[data-section="verdict"] .status-chip[data-kind="opinion"]');
  if (viewText(chip).trim() !== `${word}, not a finding`) {
    problems.push(`${page}: the verdict chip doesn't say "${word}, not a finding"`);
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

const FINDINGS = 4;
const KPIS = 4;
const LEGEND_WORDS = ["Fact", "Inferred", "Estimate"];
const TRUST_CAVEAT = "It doesn't verify placed share or velocity.";

const definitionLink = (block) =>
  [...(block?.querySelectorAll("a[href]") ?? [])].some((link) =>
    DEFINITION_LINK.test(link.getAttribute("href")),
  );

// The headline is the verdict's own sentence. verdict.text is verbatim, in view unless the dataset
// allows the popover, and everything else moved there keeps its words.
function checkHeadline(page, document, { verdict }, problems) {
  const block = document.querySelector('[data-section="verdict"]');
  if (viewText(block?.querySelector("h1")).trim() !== verdict.sentence) {
    problems.push(`${page}: the headline isn't the verdict's sentence`);
  }
  if (!viewText(block?.querySelector('[data-section="question"]')).trim()) {
    problems.push(`${page}: no question line in view`);
  }
  const panel = block?.querySelector(".info-popover__panel");
  if (verdict.textVisible) {
    if (!viewText(block).includes(verdict.text)) {
      problems.push(`${page}: verdict.text isn't in view on this dataset`);
    }
  } else if (!panel?.textContent.includes(verdict.text)) {
    problems.push(`${page}: verdict.text is neither in view nor in its popover`);
  }
  if (verdict.items.some((item) => !panel?.textContent.includes(item))) {
    problems.push(`${page}: the headline's popover has lost a verdict item`);
  }
  if (!definitionLink(panel))
    problems.push(`${page}: the headline's popover has no definition link`);
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
    if (!viewText(cell.querySelector(".status-chip")).trim()) {
      problems.push(`${page}: a KPI has no marker in view`);
    }
    const panel = cell.querySelector(".info-popover__panel");
    if (!panel?.querySelector("[data-kpi-note]")?.textContent.trim()) {
      problems.push(`${page}: a KPI's popover has no note`);
    }
    if (!definitionLink(panel)) problems.push(`${page}: a KPI's popover has no definition link`);
    if (!definitionLink(cell.querySelector("noscript"))) {
      problems.push(`${page}: a KPI's noscript note has no definition link`);
    }
  });
  if (!viewText(row).includes(expected.kpiScope)) {
    problems.push(`${page}: the KPI row doesn't say which chains it covers`);
  }
}

// A finding is its chart's heading with its marker, on a link that lands on that chart, and it says
// what the dataset says. A finding that only agrees with its card could be wrong in both places.
function checkFindings(page, document, expected, problems) {
  const word = expected.frameWord;
  const links = [...document.querySelectorAll('[data-section="findings"] a[data-finding-link]')];
  if (links.length !== FINDINGS) problems.push(`${page}: there are ${links.length} findings`);
  for (const link of links) {
    const href = link.getAttribute("href") ?? "";
    const text = viewText(link.querySelector(".finding__text")).trim();
    const chip = link.querySelector(".status-chip");
    if (!text) problems.push(`${page}: a finding has no text in view`);
    if (!viewText(chip).trim()) problems.push(`${page}: a finding has no marker in view`);
    if (word && !viewText(link).includes(word)) {
      problems.push(`${page}: a finding has no "${word}"`);
    }
    const target = href.startsWith("#") ? document.getElementById(href.slice(1)) : null;
    if (!target) {
      problems.push(`${page}: a finding links to ${href}, which isn't on the page`);
      continue;
    }
    const head = target.querySelector(".chart-card__head");
    if (head?.querySelector("h2, h3")?.textContent.trim() !== text) {
      problems.push(`${page}: a finding differs from the heading of ${href}`);
    }
    if (head?.querySelector(".status-chip")?.dataset.kind !== chip?.dataset.kind) {
      problems.push(`${page}: a finding's marker differs from ${href}`);
    }
  }
  for (const { id, text } of expected.findings) {
    const link = links.find((candidate) => candidate.getAttribute("href") === `#${id}`);
    if (viewText(link?.querySelector(".finding__text")).trim() !== text) {
      problems.push(`${page}: the finding for #${id} isn't the dataset's heading`);
    }
  }
}

function checkLegend(page, document, problems) {
  const legend = document.querySelector('[data-section="marker-legend"]');
  if (LEGEND_WORDS.some((word) => !viewText(legend).includes(word))) {
    problems.push(`${page}: the marker legend isn't in view`);
  }
  if (!definitionLink(legend?.querySelector(".info-popover__panel"))) {
    problems.push(`${page}: the marker legend's popover has no definition link`);
  }
}

function checkTrustDetail(page, document, problems) {
  const details = document.querySelectorAll('[data-section="trust-strip"] details');
  if (details.length !== 1) {
    problems.push(`${page}: the trust row has ${details.length} disclosures, not one`);
    return;
  }
  if (!details[0].textContent.includes(TRUST_CAVEAT)) {
    problems.push(`${page}: the trust row's disclosure has lost what it says it doesn't verify`);
  }
  if (!definitionLink(details[0])) {
    problems.push(`${page}: the trust row's disclosure has no definition link`);
  }
}

const PIN_NUMBER = /^\d+$/;

// A note's own words. Its pin is a number outside them, and anything else in a pin still counts.
function noteWords(note) {
  if (!inView(note)) return "";
  const copy = note.cloneNode(true);
  for (const pin of copy.querySelectorAll(".pin")) {
    if (PIN_NUMBER.test(pin.textContent.trim())) pin.remove();
  }
  // A marker says what kind of claim a note is, and isn't one of its words. Panels check it apart.
  // Only a real marker, with its kind, at the head of the note's words is left out.
  const lead = copy.querySelector(":scope > p > .status-chip[data-kind]:first-child");
  if (lead) lead.remove();
  return viewText(copy, "");
}

// The caveats needed to read a number, wherever a unit pins them. Each required instance is in view
// with nothing opened and keeps its words, read whole so a date or a link can't split a sentence.
function checkEssentialNotes(page, document, expected, problems) {
  for (const { kind, chain, text, exact } of expected.essentialNotes) {
    const selector = `[data-note="${kind}"]${chain ? `[data-chain="${chain}"]` : ""}`;
    const shown = [...document.querySelectorAll(selector)]
      .map((note) => noteWords(note).replace(/\s+/g, " "))
      .filter((words) => words.trim());
    const name = `the ${kind} note${chain ? ` for ${chain}` : ""}`;
    if (shown.length === 0) {
      problems.push(`${page}: ${name} isn't in view`);
    } else if (!shown.some((words) => (exact ? words.trim() === text : words.includes(text)))) {
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

// A card's takeaway, marker and time stay in view. Its source and definition are one tap away in the
// popover, and are in a plain note with JavaScript off, which the page's parser reads as elements
// here. The table is required by type, and this says it reached the page.
function checkCards(page, document, problems) {
  for (const card of document.querySelectorAll(".chart-card")) {
    const headings = [...card.querySelectorAll(".chart-card__head h2, .chart-card__head h3")];
    if (!headings.some((heading) => viewText(heading).trim())) {
      problems.push(`${page}: a card has no visible takeaway`);
    }
    const chips = [...card.querySelectorAll(".chart-card__head .status-chip")];
    if (!chips.some((chip) => viewText(chip).trim())) {
      problems.push(`${page}: a card has no visible marker`);
    }
    const time = visibleMeta(card)?.querySelector("time[datetime]");
    if (!time?.getAttribute("datetime").trim() || !viewText(time).trim()) {
      problems.push(`${page}: a card has no visible as-of time`);
    }
    const panel = hasSourceAndDefinition(card.querySelector(".info-popover__panel"));
    if (!panel.source) problems.push(`${page}: a card's popover has no source`);
    if (!panel.definition) problems.push(`${page}: a card's popover has no definition link`);
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
  for (const notes of document.querySelectorAll("[data-pinned-notes]")) {
    if (notes.closest("details, noscript")) {
      problems.push(`${page}: pinned notes inside a details or noscript`);
    }
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
// more. A row may sit in a closed disclosure, but it can't be hidden.
function checkExchangeRows(page, document, expected, problems) {
  const rows = [...document.querySelectorAll("[data-exchange-row]")];
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

// Every name is blocked, and only a row's own name is taken out first, so one anywhere else is still
// caught: the head, an attribute, a template, a sentence or serialized props.
function checkMainNames(page, html, expected, problems) {
  const names = expected.exchangeRows.map((row) => row.entity);
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
    // A note's pin is a number outside its words, as in noteWords.
    if (node[3]?.className === "pin" && typeof node[3].children === "number") return "";
    // And a marker isn't one of its words either, as in noteWords.
    if (/(^|\s)status-chip(\s|$)/.test(node[3]?.className ?? "")) return "";
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

// The notes this panel holds, in order, each whole and in view, and none for another chain. A pin's
// number is its note's place in that order.
function checkPanelNotes(where, panel, notes, problems) {
  const shown = [...panel.querySelectorAll("[data-pinned-notes] > [data-note]")];
  const said = shown.map((note) => `${note.dataset.note}:${note.dataset.chain ?? ""}`);
  const want = notes.map(({ kind, chain }) => `${kind}:${chain ?? ""}`);
  if (said.join() !== want.join()) {
    problems.push(`${where}: its notes are ${said.join()}, not ${want.join()}`);
    return;
  }
  notes.forEach(({ kind, words, chip }, index) => {
    if (noteWords(shown[index]).replace(/\s+/g, " ").trim() !== words) {
      problems.push(`${where}: its ${kind} note doesn't keep its words in view`);
    }
    const markers = shown[index].querySelectorAll(".status-chip");
    const marker = markers[0];
    if (
      markers.length > (chip ? 1 : 0) ||
      (chip ?? null) !== (marker?.dataset.kind ?? null) ||
      (chip && !viewText(marker).trim())
    ) {
      problems.push(`${where}: its ${kind} note's marker isn't ${chip ?? "absent"}`);
    }
    if (plainText(shown[index].querySelector(".pin")) !== String(index + 1)) {
      problems.push(`${where}: its ${kind} note has the wrong number`);
    }
  });
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
  parts.forEach(({ key, label, compact, share, floor, pins, bandLine }, index) => {
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
    const numbers = [...row.querySelectorAll(".pin")].map(plainText);
    if (numbers.join() !== pins.join()) {
      problems.push(`${where}: its ${key} legend row points at notes ${numbers.join()}`);
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
// wallet figure outside its popover and table, whatever the stats list says.
function checkPanelAgainstKpis(where, panel, want, problems) {
  const shown = panel.cloneNode(true);
  for (const hidden of shown.querySelectorAll(".data-toggle, .info-popover, .sr-only, noscript")) {
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

function checkSupplyPanels(page, document, expected, problems) {
  if (expected.supplyPanels.length === 0) return;
  const id = CARD_ANCHORS.supply;
  const box = panelsOf(page, document, id, expected, problems);
  for (const want of expected.supplyPanels) {
    const panel = panelOf(box, want.value);
    const where = `${page}: the ${want.value} panel of #${id}`;
    if (!panel) continue;
    if (!inView(panel)) problems.push(`${where}: it's hidden by its markup`);
    const heading = panel.querySelector(".chart-card__head h2, .chart-card__head h3");
    if (viewText(heading).trim() !== want.heading) {
      problems.push(`${where}: its heading isn't the dataset's`);
    }
    checkPanelBar(where, panel, want, problems);
    checkPanelLegend(where, panel, want, problems);
    checkPanelStats(where, panel, want.stats, problems);
    checkPanelNotes(where, panel, want.notes, problems);
    const full = panel.querySelector('.info-popover__panel [data-full-note="placed"]');
    if (!full?.textContent.includes(want.placedNote)) {
      problems.push(`${where}: its popover has lost the placed note in full`);
    }
    checkPanelAgainstKpis(where, panel, want, problems);
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
    // Rows add up across chains, so they sit under All. checkExchangeRows holds what each one says.
    const rows = panel.querySelectorAll(".data-toggle [data-labels-table] [data-exchange-row]");
    if (rows.length !== want.entities) {
      problems.push(
        `${where}: it has ${rows.length} exchange rows under its toggle, not ${want.entities}`,
      );
    }
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
    const full = panel.querySelector('.info-popover__panel [data-full-note="series-start"]');
    if (!full?.textContent.includes(want.fullNote)) {
      problems.push(`${where}: its popover has lost the series note in full`);
    }
    checkTableRows(
      where,
      panel.querySelector(".data-toggle table"),
      SERIES_COLUMNS,
      want.rows,
      problems,
    );
    const lines = [...panel.querySelectorAll("[data-series-line]")];
    const figures = lines.map((line) => viewText(line.querySelector("[data-series-value]")).trim());
    if (figures.join() !== want.latest.join()) {
      problems.push(`${where}: its legend's figures aren't the newest day's`);
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

function velocityExpected(kpis, warnings) {
  const chart = velocityChart(kpis, warnings);
  return {
    heading: velocityHeading(kpis),
    bars: chart.groups.flatMap((group) =>
      group.bars.map((bar) => `${group.chain}:${bar.measure}=${bar.text}@${bar.widthBps}`),
    ),
    notes: chart.notes.map(({ kind, chain, text }) => ({ kind, chain, words: text })),
    fullWarnings: chart.fullWarnings,
  };
}

// Velocity by chain: each bar's figure and width, each warning's pin beside its own chain and
// nowhere else, the notes in view with their words, each warning whole in the popover, and the
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
  const pinned = [...card.querySelectorAll("[data-velocity-chain] .velocity-chart__name .pin")].map(
    (pin) => `${pin.closest("[data-velocity-chain]").dataset.velocityChain}=${plainText(pin)}`,
  );
  const pins = want.notes.flatMap(({ chain }, index) => (chain ? [`${chain}=${index + 1}`] : []));
  if (pinned.join() !== pins.join()) {
    problems.push(`${where}: its chain pins are ${pinned.join()}, not ${pins.join()}`);
  }
  for (const { chain, text } of want.fullWarnings) {
    const full = card.querySelector(
      `.info-popover__panel [data-full-note="velocity-warning"][data-chain="${chain}"]`,
    );
    if (plainText(full) !== text)
      problems.push(`${where}: its popover has lost ${chain}'s warning`);
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

// The full notes a card's popover must hold, by kind.
function checkFullNotes(where, panel, fullNotes, problems) {
  for (const [kind, text] of Object.entries(fullNotes)) {
    const full = panel.querySelector(`.info-popover__panel [data-full-note="${kind}"]`);
    if (plainText(full) !== text)
      problems.push(`${where}: its popover has lost the ${kind} note in full`);
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
    const pinned = rows.flatMap((row) =>
      [...row.querySelectorAll(".pin")].map((pin) => `${row.dataset.step}=${plainText(pin)}`),
    );
    const pins = want.notes.flatMap(({ step }, index) => (step ? [`${step}=${index + 1}`] : []));
    if (pinned.join() !== pins.join()) {
      problems.push(`${where}: its pins are ${pinned.join()}, not ${pins.join()}`);
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
    const pins = [...panel.querySelectorAll(".chart-area [data-chart-pins] .pin")].map(plainText);
    if (pins.join() !== want.notes.map((_, index) => String(index + 1)).join()) {
      problems.push(`${where}: its pins don't match its notes`);
    }
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
  if (rows.length !== expected.exchangeRows.length) {
    problems.push(`${place}: the payload has ${rows.length} exchange rows`);
  }
  expected.exchangeRows.forEach(({ entity, detail, sourceHref, sourceText }, index) => {
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
      .map(words);
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

// The band beside each bar and in the table, as the dataset gives it.
function checkBands(page, document, expected, problems) {
  const lines = [...document.querySelectorAll("[data-exchange-linked]")];
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
  for (const page of ["index.html", "methodology/index.html"]) {
    if (!files.includes(join(outDir, page))) problems.push(`${page}: missing`);
  }
  for (const path of pages) {
    const page = relative(outDir, path);
    const html = readFileSync(path, "utf8");
    const { document } = new JSDOM(html).window;
    const nodes = allTextNodes(document);
    const text = nodes.map((node) => node.data).join(" ");
    checkEveryPage(page, document, problems);
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
    if (page === "index.html") {
      checkMainFrame(page, document, expected, problems);
      checkMainFreshness(page, document, expected, problems);
      checkHeadline(page, document, expected, problems);
      checkKpiRow(page, document, expected, problems);
      checkFindings(page, document, expected, problems);
      checkLegend(page, document, problems);
      checkTrustDetail(page, document, problems);
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
      const names = own ? expected.exchangeRows.map((row) => row.entity) : [];
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
    {
      kind: "exchange-floor",
      text: `${EXCHANGE_FLOOR_NOTE} ${EXCHANGE_FLOOR_LINK}.`,
      exact: true,
    },
    { kind: "series-start", text: seriesStartPin(definitions), exact: true },
    { kind: "small-ticket", text: SMALL_TICKET_PIN, exact: true },
    { kind: "everyday-meaning", text: everydayNote(definitions), exact: true },
    { kind: "velocity-denominators", text: VELOCITY_PIN, exact: true },
    { kind: "no-swaps", text: NO_SWAPS_NOTE },
    // The wallet counts beside the supply bar. The velocity table's sit under its toggle, so its
    // caption says it there, which checkVelocity holds.
    { kind: "wallets-not-people", text: WALLETS_ACROSS_CHAINS_NOTE },
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
        text: exchangeCoverageNote(chain),
        exact: true,
      })),
  ];
}

// The four headings, recomputed here so a finding is held to the dataset as well as to its card.
function expectedFindings({ manifest, journey, activity, chain_roles }) {
  const chains = activityChains(activity.data);
  return [
    { id: CARD_ANCHORS.supply, text: journeyHeading(journey.data, manifest.definitions) },
    { id: CARD_ANCHORS.waterfall, text: waterfallHeading(waterfall(activity.data), chains) },
    { id: CARD_ANCHORS.weekly, text: weeklyHeading(weeklyEveryday(activity.data), chains) },
    { id: CARD_ANCHORS.chainRoles, text: chainRolesHeading(chain_roles.data) },
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
  };
  const activityInputs = {
    activity: activity.data,
    kpis: summary.kpis,
    definitions: manifest.definitions,
  };
  const noteWordsOf = ({ kind, chain, text, link, segment }) => ({
    kind,
    chain,
    segment,
    words: link ? `${text} ${link.text}.` : text,
  });
  return {
    filter: options.map(({ value, label }) => ({ value, label })),
    supplyPanels: options.map((option) => {
      const panel = supplyPanel(option, inputs);
      const notes = panel.notes.map(noteWordsOf);
      return {
        value: option.value,
        heading: panel.heading,
        key: panel.bar?.key ?? null,
        total: panel.bar?.journey.total_supply ?? null,
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
          pins: notes.flatMap((note, index) =>
            note.segment === segment.key ? [String(index + 1)] : [],
          ),
        })),
        stats: panel.stats,
        notes,
        table: panel.table,
        chains: option.chains.length,
        ...kpiFigures(option, summary.kpis, journey.data),
        placedNote: PLACED_NOTE,
        entities: panel.segments.flatMap((segment) => segment.entities ?? []).length,
      };
    }),
    velocity: velocityExpected(summary.kpis, manifest.warnings),
    grid: chainGrid(files.chain_roles.data),
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
        notes: panel.notes.map(({ kind, text, step, chip }) => ({ kind, words: text, step, chip })),
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
        latest: panel.latest
          ? [
              panel.latest.total_supply,
              panel.latest.circulating_supply,
              panel.latest.placed_supply,
            ].map(formatCompact)
          : [],
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
  const { kind, frameWord, freshness, asOfLine, trustLine } = state;
  const { manifest, summary } = files;
  const { verdict } = summary;
  return {
    kind,
    frameWord,
    freshness,
    asOfLine,
    trustLine,
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
    kpiScope: `Across ${summary.kpis.map((row) => CHAIN_NAMES[row.chain]).join(", ")}.`,
    kpiValues: expectedKpiValues(summary.kpis),
    findings: expectedFindings(files),
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
