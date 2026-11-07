import type { Expected } from "./expected.ts";
import { BASE58_ADDRESS, EVM_ADDRESS } from "./constants.ts";
import { escapedNameMatcher, plainText } from "./dom.ts";

export function checkAddresses(
  page: string,
  texts: string[],
  allowedAddresses: Set<string>,
  problems: string[],
) {
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
export const OWN_PAYLOAD = /^(index|__next\._full|__next\.__PAGE__)\.txt$/;

// What may name an exchange in the page's serialized props: its row's own name, once.
export const withoutPayloadNames = (raw: string, names: string[], quote: string) =>
  names.reduce(
    (rest: string, name: string) =>
      rest.replace(
        `${quote}data-exchange-name${quote}:true,${quote}children${quote}:${quote}${name}${quote}`,
        "",
      ),
    raw,
  );

const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

// So a name reads as a name however it's written: an escape, a zero-width split, or a tag in it.
function readable(raw: string) {
  const plain = raw
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .normalize("NFKC")
    .replace(INVISIBLE, "");
  return `${plain}\n${plain.replace(/<[^>]*>/g, "")}`;
}

// Every blocked name, as a whole word and in its own case, as ordinary words are on that list. A row's
// name is distinctive, so it's found in any case and inside a longer word as well. Each row's own
// source link is the one place its host may appear.
function namesFound(raw: string, expected: Expected) {
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

export function checkNames(place: string, raw: string, expected: Expected, problems: string[]) {
  for (const name of namesFound(raw, expected)) problems.push(`${place}: names "${name}"`);
}

// Every row the main page writes, in its order: All's, then each chain's own on its supply card.
export const everyRow = (expected: Expected) => [
  ...expected.exchangeRows,
  ...expected.supplyPanels
    .filter(({ value }) => value !== "all")
    .flatMap(({ exchanges }) => exchanges.rows),
];

// Every name is blocked, and only a row's own name is taken out first, once per row, so one
// anywhere else is still caught: the head, an attribute, a template, a sentence or serialized props.
export function checkMainNames(
  page: string,
  source: Document,
  expected: Expected,
  problems: string[],
) {
  const names = everyRow(expected).map((row) => row.entity);
  // A copy, as the names are cleared from it, and in the page's own window, as a window of its own
  // would hold a second copy of the page in memory.
  const document = source.cloneNode(true) as Document;
  for (const row of document.querySelectorAll("[data-exchange-row]")) {
    const name = row.querySelector("[data-exchange-name]");
    if (name && names.includes(name.textContent)) name.textContent = "";
  }
  const rest = withoutPayloadNames(document.documentElement.outerHTML, names, '\\"');
  checkNames(page, rest, expected, problems);
}

// Allowed only in the labels table, in the legend (its words are the labels file's own and carry
// a label's source rule), or as the whole words of a link to the named party's own site.
const SOURCE_SITES: Record<string, string> = {
  Coinbase: "coinbase.com",
  Crystal: "crystalintelligence.com",
  Kraken: "kraken.com",
};

function ownSourceLink(link: Element, name: string) {
  const site = SOURCE_SITES[name];
  if (!site || plainText(link) !== name) return false;
  const host = new URL(link.getAttribute("href")!).hostname;
  return host === site || host.endsWith(`.${site}`);
}

export function checkMethodologyNames(
  page: string,
  source: Document,
  expected: Expected,
  problems: string[],
) {
  // A copy, as the allowed parts are taken out of it.
  const document = source.cloneNode(true) as Document;
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
