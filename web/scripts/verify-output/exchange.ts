import type { Expected } from "./expected.ts";
import { outOfView, plainText } from "./dom.ts";

// The rows are the dataset's, in its order, and each says exactly what the dataset gives and nothing
// more. A row may sit in a closed disclosure, but it can't be hidden. A chain's own rows, on its
// supply card, are held by checkPanelExchanges and named by checkPayload.
const ownRows = (document: Document) =>
  [...document.querySelectorAll("[data-exchange-row]")].filter(
    (row) => !row.closest('[data-chain-panel]:not([data-chain-panel="all"])'),
  );

export function checkExchangeRows(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
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

// The band's line in the supply card's legend, which is the first option's, and each chain's in the
// table, as the dataset gives them.
export function checkBands(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  const lines = [...document.querySelectorAll<HTMLElement>("[data-exchange-linked]")];
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
