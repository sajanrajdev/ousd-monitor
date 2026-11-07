import type { Expected } from "./expected.ts";
import { readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { BINARY_EXTENSIONS } from "./constants.ts";
import { allTextNodes, closeHtml, filesUnder, parseHtml } from "./dom.ts";
import {
  checkCards,
  checkEveryPage,
  checkFooterStatus,
  checkFreshnessOnPage,
  checkLinksAndRequests,
  checkStateOnPage,
  checkTooltips,
} from "./every-page.ts";
import {
  checkEssentialNotes,
  checkHeadline,
  checkKpiRow,
  checkMainFrame,
  checkMainFreshness,
  checkNoPushDown,
} from "./main-page.ts";
import { checkReconciliationPage } from "./reconciliation.ts";
import {
  OWN_PAYLOAD,
  checkAddresses,
  checkMainNames,
  checkMethodologyNames,
  checkNames,
  everyRow,
  withoutPayloadNames,
} from "./names.ts";
import { checkBands, checkExchangeRows } from "./exchange.ts";
import { checkPayload, inlineFlight } from "./flight.ts";
import { checkFilter } from "./filter.ts";
import { checkSupplyPanels } from "./supply.ts";
import { checkSeriesPanels } from "./series.ts";
import { checkVelocity } from "./velocity.ts";
import { checkGrid } from "./grid.ts";
import { checkWaterfallPanels, checkWeeklyPanels } from "./activity.ts";
import { checkEveryFile } from "./files.ts";

// What a caller may pass: the checks read only the fields they need, so a test can give a few.
export type ExpectedInput = { [K in keyof Expected]?: unknown } & Record<string, unknown>;

// Returns every problem found. An empty list is a pass.
export function verifyOutput(outDir: string, given: ExpectedInput) {
  const expected = given as Expected;
  const problems: string[] = [];
  const files = filesUnder(outDir);
  const pages = files.filter((path) => path.endsWith(".html"));
  const allowedAddresses = new Set(Object.values(expected.tokenContracts));
  for (const page of ["index.html", "methodology/index.html", "reconciliation/index.html"]) {
    if (!files.includes(join(outDir, page))) problems.push(`${page}: missing`);
  }
  for (const path of pages) {
    const page = relative(outDir, path);
    const html = readFileSync(path, "utf8");
    const document = parseHtml(html);
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
      checkMethodologyNames(page, document, expected, problems);
    } else {
      // No page but the methodology has a reason to hold one, seen or serialized.
      checkAddresses(page, [html, text], new Set(), problems);
      if (page === "index.html") {
        checkMainNames(page, document, expected, problems);
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
    closeHtml(document);
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

export { expectedFromDataset, expectedFromFiles } from "./expected.ts";
