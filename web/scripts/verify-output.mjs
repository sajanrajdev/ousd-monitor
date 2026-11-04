// Runs on every build. Reads what was really written, and takes what to expect from the dataset, not
// from an argument, so no build can talk its way past it. Usage: verify-output.mjs <output folder>
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { loadDatasetFiles, locateDataset } from "../lib/dataset/load.ts";
import { deriveState } from "../lib/dataset/state.ts";
import { TOKEN_CONTRACTS } from "../lib/definitions.ts";

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

function visibleTextNodes(document) {
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

function checkEveryPage(page, document, text, problems) {
  if (!text.includes(INDEPENDENCE_LINE)) problems.push(`${page}: no independence line`);
  if (!/not financial advice/i.test(text)) problems.push(`${page}: no "not financial advice"`);
}

function checkStateOnPage(page, document, text, expected, problems) {
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
  if (!banner) problems.push(`${page}: no ${word} banner`);
  if (!document.title.startsWith(`[${word}]`)) problems.push(`${page}: no [${word}] in the title`);
  const robots = document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "";
  if (!robots.includes("noindex")) problems.push(`${page}: no noindex`);
  for (const card of document.querySelectorAll(".chart-card")) {
    if (card.getAttribute("data-frame") !== word) {
      problems.push(`${page}: a card has no ${word} edge`);
    }
    if (!card.querySelector(".chart-card__meta")?.textContent.includes(word)) {
      problems.push(`${page}: a card has no "${word}" beside its as-of time`);
    }
  }
  if (text.includes("Our reading")) problems.push(`${page}: "Our reading" on non-real data`);
}

function checkMainFrame(page, document, text, expected, problems) {
  const word = expected.frameWord;
  if (!word) return;
  if (!text.includes(`${word}, not a finding`)) {
    problems.push(`${page}: no "${word}, not a finding"`);
  }
  if (!document.querySelector('[data-section="kpi-row"]')?.textContent.includes(word)) {
    problems.push(`${page}: no "${word}" in the KPI row`);
  }
  if (
    !document.querySelector('[data-section="trust-strip"]')?.textContent.includes("Not reconciled")
  ) {
    problems.push(`${page}: the trust strip doesn't say "Not reconciled"`);
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

function checkCards(page, document, problems) {
  for (const card of document.querySelectorAll(".chart-card")) {
    const meta = card.querySelector(".chart-card__meta");
    if (!meta?.textContent.includes("Source:")) problems.push(`${page}: a card has no source`);
    if (!meta?.querySelector("time[datetime]")) problems.push(`${page}: a card has no as-of time`);
    const link = meta?.querySelector('a[href*="#"]');
    if (!link) problems.push(`${page}: a card has no definition link`);
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
    const nodes = visibleTextNodes(document);
    const text = nodes.map((node) => node.data).join(" ");
    checkEveryPage(page, document, text, problems);
    checkStateOnPage(page, document, text, expected, problems);
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
    if (page === "index.html") checkMainFrame(page, document, text, expected, problems);
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

export function expectedFromDataset(location, webRoot = process.cwd(), now = Date.now()) {
  const { files, placement } = loadDatasetFiles(location, webRoot);
  return expectedFromFiles(files, placement, webRoot, now);
}

export function expectedFromFiles(files, placement, webRoot = process.cwd(), now = Date.now()) {
  const { kind, frameWord } = deriveState(files, placement, now);
  const { manifest } = files;
  return {
    kind,
    frameWord,
    version: manifest.dataset_version,
    pipelineStrings: [
      ...manifest.checks.map((check) => check.detail),
      ...(manifest.stale_reason ? [manifest.stale_reason] : []),
    ],
    blockedNames: JSON.parse(readFileSync(join(webRoot, "scripts/blocked-names.json"), "utf8")),
    tokenContracts: TOKEN_CONTRACTS,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = verifyOutput(process.argv[2], expectedFromDataset(locateDataset()));
  for (const problem of problems) console.error(problem);
  process.exit(problems.length > 0 ? 1 : 0);
}
