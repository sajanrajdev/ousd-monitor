// Runs on every build. Reads what was really written, and takes what to expect from the dataset, not
// from an argument, so no build can talk its way past it. Usage: verify-output.mjs <output folder>
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { loadDatasetFiles, locateDataset } from "../lib/dataset/load.ts";
import { deriveState } from "../lib/dataset/state.ts";
import { allChainKpis, newestByChain } from "../lib/aggregate.ts";
import { CARD_ANCHORS, CHAIN_NAMES, TOKEN_CONTRACTS } from "../lib/definitions.ts";
import { formatBps, formatCompact, UNKNOWN_TEXT } from "../lib/format.ts";
import {
  activityChains,
  day0Scope,
  historyLabel,
  velocityWarnings,
  waterfall,
  waterfallHeading,
  weeklyEveryday,
  weeklyHeading,
} from "../lib/takeaways/activity.ts";
import {
  day0Note,
  everydayNote,
  historyNote,
  HOPS_NOTE,
  issuerUnlabeledNote,
  NO_SWAPS_NOTE,
  PLACED_NOTE,
  seriesStartNote,
  SMALL_TICKET_LEAD,
  SMALL_TICKET_NOTE,
  VELOCITY_NOTE,
  WALLETS_ACROSS_CHAINS_NOTE,
  WALLETS_NOTE,
} from "../lib/takeaways/caveats.ts";
import { chainRolesHeading } from "../lib/takeaways/chain-roles.ts";
import { journeyHeading } from "../lib/takeaways/journey.ts";
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

// In view with nothing opened: not hidden, and inside no details but in its summary. CSS can't be
// read here, so the browser checks in acceptance.mjs cover what a stylesheet hides.
function inView(element) {
  if (element.closest(OUT_OF_VIEW)) return false;
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

// The caveats needed to read a number, wherever a unit pins them. Each required instance is in view
// with nothing opened and keeps its words, read whole so a date or a link can't split a sentence.
function checkEssentialNotes(page, document, expected, problems) {
  for (const { kind, chain, text } of expected.essentialNotes) {
    const selector = `[data-note="${kind}"]${chain ? `[data-chain="${chain}"]` : ""}`;
    const shown = [...document.querySelectorAll(selector)]
      .map((note) => viewText(note, "").replace(/\s+/g, " "))
      .filter((words) => words.trim());
    const name = `the ${kind} note${chain ? ` for ${chain}` : ""}`;
    if (shown.length === 0) {
      problems.push(`${page}: ${name} isn't in view`);
    } else if (!shown.some((words) => words.includes(text))) {
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

function checkBlockedNames(page, html, blockedNames, problems) {
  for (const name of blockedNames) {
    if (escapedNameMatcher(name).test(html)) problems.push(`${page}: names "${name}"`);
  }
}

// Allowed only in the labels table, in the legend (its words are the labels file's own and carry
// a label's source rule), or beside the source that names it.
function checkMethodologyNames(page, nodes, blockedNames, problems) {
  for (const name of blockedNames) {
    const matcher = escapedNameMatcher(name);
    for (const node of nodes) {
      if (!matcher.test(node.data)) continue;
      const element = node.parentElement;
      const block = element.closest("tr, li, p, dd, td");
      const sourced =
        element.closest("[data-labels-table], [data-source-legend]") ||
        block?.querySelector('a[href^="https://"]');
      if (!sourced) problems.push(`${page}: names "${name}" with no source beside it`);
    }
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
      checkMethodologyNames(page, nodes, expected.blockedNames, problems);
    } else {
      // No page but the methodology has a reason to hold one, seen or serialized.
      checkAddresses(page, [html, text], new Set(), problems);
      checkBlockedNames(page, `${html}\n${text}`, expected.blockedNames, problems);
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
    }
  }
  for (const path of files) {
    if (BINARY_EXTENSIONS.has(extname(path))) continue;
    const content = readFileSync(path, "utf8");
    const name = relative(outDir, path);
    checkEveryFile(name, content, expected, problems);
    // Serialized props, as a name or address in them is on its way to the reader.
    if (name.endsWith(".txt") && !name.startsWith(`methodology${sep}`)) {
      checkBlockedNames(name, content, expected.blockedNames, problems);
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
    { kind: "placed", text: PLACED_NOTE },
    { kind: "series-start", text: seriesStartNote(definitions) },
    { kind: "small-ticket", text: `${SMALL_TICKET_LEAD} ${SMALL_TICKET_NOTE}` },
    { kind: "velocity-denominators", text: VELOCITY_NOTE },
    { kind: "no-swaps", text: NO_SWAPS_NOTE },
    { kind: "wallets-not-people", text: WALLETS_ACROSS_CHAINS_NOTE },
    { kind: "wallets-not-people", text: WALLETS_NOTE },
    ...(waterfall(rows)
      ? [
          { kind: "hops", text: HOPS_NOTE },
          { kind: "everyday-meaning", text: everydayNote(definitions) },
        ]
      : []),
    ...(scope ? [{ kind: "day-0-scope", text: day0Note(scope) }] : []),
    ...(weeklyEveryday(rows).length > 0
      ? [{ kind: "history", text: historyNote(historyLabel(rows)) }]
      : []),
    ...velocityWarnings(manifest.warnings).map(({ chain, text }) => ({
      kind: "velocity-warning",
      chain,
      text,
    })),
    ...newestByChain(journey.data)
      .filter((row) => !row.issuer_labeled && BigInt(row.issuer_inventory) === 0n)
      .map(({ chain }) => ({
        kind: "issuer-unlabeled",
        chain,
        text: issuerUnlabeledNote(chain),
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
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = verifyOutput(process.argv[2], expectedFromDataset(locateDataset()));
  for (const problem of problems) console.error(problem);
  process.exit(problems.length > 0 ? 1 : 0);
}
