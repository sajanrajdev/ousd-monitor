import type { Expected } from "./expected.ts";
import { CARD_ANCHORS } from "../../lib/definitions.ts";
import { inView, plainText, viewText } from "./dom.ts";
import { checkPanelNotes, checkTableRows, panelOf, panelsOf } from "./panels.ts";

const SERIES_LINES = ["Total", "Circulating", "Placed"];

const SERIES_COLUMNS = [
  { key: "day", label: "Day" },
  { key: "total", label: "Total" },
  { key: "placed", label: "Placed" },
  { key: "circulating", label: "Circulating" },
];

export function checkSeriesPanels(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
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
