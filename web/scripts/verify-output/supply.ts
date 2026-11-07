import type { Expected } from "./expected.ts";
import { CARD_ANCHORS } from "../../lib/definitions.ts";
import { WALLETS_ACROSS_CHAINS_NOTE } from "../../lib/takeaways/caveats.ts";
import { inView, viewText } from "./dom.ts";
import {
  WALLET_TABLE_COLUMNS,
  checkPanelAgainstKpis,
  checkPanelAgainstRows,
  checkPanelBar,
  checkPanelExchanges,
  checkPanelLegend,
  checkPanelNotes,
  checkPanelStats,
  checkTableRows,
  panelOf,
  panelsOf,
} from "./panels.ts";

// A card per filter option, each with every chain's bar, the first over all of them, so the bars
// compare chains whichever is chosen. Its heading, legend, figures, notes and tables are the option's
// own. On a chain's card that chain's bar is marked and the others are muted.
export function checkSupplyPanels(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  if (expected.supplyPanels.length === 0) return;
  const id = CARD_ANCHORS.supply;
  const box = panelsOf(page, document, id, expected, problems);
  const wanted = expected.supplyPanels.map(({ value }) => value);
  for (const want of expected.supplyPanels) {
    const panel = panelOf(box, want.value);
    const where = `${page}: the ${want.value} panel of #${id}`;
    if (!panel) continue;
    if (!inView(panel)) problems.push(`${where}: it's hidden by its markup`);
    const rows = [...panel.querySelectorAll<HTMLElement>("[data-supply-row]")];
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
