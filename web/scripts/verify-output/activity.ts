import type { Expected } from "./expected.ts";
import { CARD_ANCHORS } from "../../lib/definitions.ts";
import { formatCompact } from "../../lib/format.ts";
import { PERIOD_COLUMNS, STEP_COLUMNS, WEEK_COLUMNS } from "../../lib/activity-panels.ts";
import { inView, viewText } from "./dom.ts";
import {
  checkFullNotes,
  checkHeadingOf,
  checkPanelNotes,
  checkTableRows,
  panelOf,
  panelsOf,
} from "./panels.ts";

// Each filter option's waterfall: its rows in order with their figures, each pin on its row with its
// note's number, its notes, the notes in full and both tables.
export function checkWaterfallPanels(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  if (expected.waterfallPanels.length === 0) return;
  const id = CARD_ANCHORS.waterfall;
  const box = panelsOf(page, document, id, expected, problems);
  for (const want of expected.waterfallPanels) {
    const panel = panelOf(box, want.value);
    const where = `${page}: the ${want.value} panel of #${id}`;
    if (!panel) continue;
    if (!inView(panel)) problems.push(`${where}: it's hidden by its markup`);
    checkHeadingOf(where, panel, want.heading, problems);
    const rows = [...panel.querySelectorAll<HTMLElement>(".chart-area [data-step]")];
    const said = rows.map(
      (row) => `${row.dataset.step}=${viewText(row.querySelector(".tabular-nums"), "").trim()}`,
    );
    const wanted = want.steps.map(({ key, figure }) => `${key}=${figure}`);
    if (said.join() !== wanted.join()) {
      problems.push(`${where}: its rows aren't the dataset's`);
    }
    // The same figures from the rows themselves. The amount sits after the sign, if any.
    for (const row of rows) {
      const sum = want.sums[row.dataset.step!];
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
export function checkWeeklyPanels(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
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
    const bars = [...panel.querySelectorAll<HTMLElement>(".chart-area [data-week]")].map(
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
