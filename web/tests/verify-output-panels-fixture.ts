// The planted real main page the supply and step line panel tests share, with the helpers that
// change one panel, bar row or card in it. Its tests are two files, so two workers: in one, the
// planted page with a supply card per filter option ran CI's worker out of memory.
import { CARD_ANCHORS } from "@/lib/definitions";
import { expectedFromDataset, verifyOutput } from "@/scripts/verify-output.mjs";
import { at, plantFile, releaseGrade, tempDir } from "./dataset-helpers";
import {
  plantedFlight,
  plantedFooter,
  plantedRealMain,
  plantedReconciliationMain,
  PLANTED_HEADER,
  plantedBack,
} from "./planted-first-screen";

// Each test parses a whole planted main page several times, so a slower machine takes seconds over
// one, and these tests get longer than the default.
export const WHOLE_PAGE_TIMEOUT_MS = 30_000;
// The release-grade copy, long past its 36 hours, so its detail page states its last run as old.
const RECONCILED_TRUST =
  "Last run 4 Nov 2026, 05:30 UTC: every check passed. Nothing newer has reached this page, so it may be out of date.";

function site({ main, methodology }: { main: string; methodology: string }) {
  const dir = tempDir();
  plantFile(dir, "index.html", main);
  plantFile(dir, "methodology/index.html", plantedBack(methodology));
  plantFile(
    dir,
    "reconciliation/index.html",
    methodology.replace("<main>Fine</main>", plantedReconciliationMain(RECONCILED_TRUST)),
  );
  return dir;
}

export function supplyHarness() {
  const TRUST =
    "Last reconciled 4 Nov 2026, 05:30 UTC. Nothing newer has reached this page, so it may be out of date.";
  const location = at(releaseGrade());
  const expected = expectedFromDataset(location);
  const main = plantedRealMain(expected, TRUST);
  const realPage = (body: string) =>
    `<!doctype html><html data-dataset-kind="real" data-dataset-version="${expected.version}" data-freshness="stale"><head><title>Open USD Monitor</title></head><body>
    ${PLANTED_HEADER}${plantedFlight([])}${body}
    ${plantedFooter(false, { fresh: null, stale: TRUST, short: "Last reconciled 4 Nov" })}</body></html>`;
  const check = (body: string, against = expected) =>
    verifyOutput(
      site({ main: realPage(body), methodology: realPage("<main>Fine</main>") }),
      against,
    );
  const panelOf = (html: string, id: string, value: string) => {
    const box = html.indexOf(`id="${id}"`);
    const start = html.indexOf(`data-chain-panel="${value}"`, box);
    const next = html.indexOf('<div data-chain-panel="', start + 1);
    const close = html.indexOf('<div id="', start);
    const end = Math.min(...[next, close].filter((at) => at !== -1));
    return { start, end };
  };
  // A fault in one of the step line's panels, so a right answer in another can't hide it.
  const inPanel = (value: string, change: (panel: string) => string, id: string) => {
    const { start, end } = panelOf(main, id, value);
    return `${main.slice(0, start)}${change(main.slice(start, end))}${main.slice(end)}`;
  };
  const faults = (panel: string, value: string) =>
    check(panel).filter((problem: string) => problem.includes(`the ${value} panel`));
  // The supply card has a panel per option, each with every option's bar: a fault in one of All's
  // bar rows, or in All's card around them. A chain's panel is changed with inPanel.
  const S = CARD_ANCHORS.supply;
  const CARD = `index.html: the all panel of #${S}`;
  const rowOf = (html: string, value: string) => {
    const start = html.indexOf(`<div data-supply-row="${value}"`, html.indexOf(`id="${S}"`));
    const ends = [
      html.indexOf("<div data-supply-row=", start + 1),
      html.indexOf("data-supply-legend", start),
    ];
    return { start, end: Math.min(...ends.filter((at) => at !== -1)) };
  };
  const inRow = (value: string, change: (row: string) => string) => {
    const { start, end } = rowOf(main, value);
    return `${main.slice(0, start)}${change(main.slice(start, end))}${main.slice(end)}`;
  };
  const inCard = (change: (card: string) => string) => inPanel("all", change, S);
  // A change from the legend on, which takes in the card's footnotes after its as-of line.
  const inLegend = (change: (legend: string) => string) =>
    inCard((html) => {
      const at = html.indexOf("data-supply-legend");
      return `${html.slice(0, at)}${change(html.slice(at))}`;
    });
  const cardFaults = (body: string) =>
    check(body).filter((problem: string) => problem.startsWith(CARD));
  const rowFaults = (body: string, value: string) =>
    check(body).filter((problem: string) => problem.startsWith(`${CARD}, the ${value} bar`));

  return {
    TRUST,
    location,
    expected,
    main,
    realPage,
    check,
    panelOf,
    inPanel,
    faults,
    S,
    CARD,
    rowOf,
    inRow,
    inCard,
    inLegend,
    cardFaults,
    rowFaults,
  };
}
