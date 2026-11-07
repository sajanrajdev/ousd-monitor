import { readdirSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// Each page is parsed into a window of its own, closed once its checks are done. jsdom keeps a
// closed window's page in memory until the stack unwinds, about 20 MB for the main page, so the
// checks parse each page once and read from it, rather than starting another window.
export function parseHtml(html: string): Document {
  return new JSDOM(html).window.document;
}

export function closeHtml(document: Document) {
  document.defaultView!.close();
}

export function filesUnder(dir: string): string[] {
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

function hiddenByMarkup(element: Element) {
  const style = (element.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();
  if (HIDING_STYLE.some((pattern) => pattern.test(style))) return true;
  const classes = [...element.classList];
  return classes.includes("hidden") && !classes.some((name) => REVEALED_CLASS.test(name));
}

export function outOfView(element: Element) {
  if (element.closest(OUT_OF_VIEW)) return true;
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (hiddenByMarkup(at)) return true;
  }
  return false;
}

// In view with nothing opened: not hidden, and inside no details but in its summary. CSS can't be
// read here, so the browser checks in acceptance.mjs cover what a stylesheet hides.
export function inView(element: Element) {
  if (outOfView(element)) return false;
  for (let d = element.closest("details"); d; d = d.parentElement?.closest("details") ?? null) {
    if (!d.querySelector(":scope > summary")?.contains(element)) return false;
  }
  return true;
}

export function viewText(element: Element | null, joiner = " ") {
  if (!element || !inView(element)) return "";
  const { NodeFilter } = element.ownerDocument.defaultView!;
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (inView(node.parentElement!)) text += `${(node as Text).data}${joiner}`;
  }
  return text;
}

// The card's visible line.
export function visibleMeta(card: Element) {
  return [...card.querySelectorAll(".chart-card__meta")].find(inView);
}

// Every text node, for the scans that must find a thing wherever it sits, seen or not.
export function allTextNodes(document: Document) {
  const { NodeFilter } = document.defaultView!;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement!.closest("script, style, template")) nodes.push(node as Text);
  }
  return nodes;
}

export function escapedNameMatcher(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`);
}

export const plainText = (element: Element | null | undefined) =>
  element?.textContent!.replace(/\s+/g, " ").trim() ?? "";
