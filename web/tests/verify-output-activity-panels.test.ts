import { describe, expect, it } from "vitest";
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

// Each whole-page group is a file of its own, and so a worker of its own, as one worker running
// them all ran out of memory in CI.
// In a file of their own, so a worker of their own: each test parses a whole planted main page several
// times, which the heap of a file with hundreds of tests can't also hold. For the same reason they get
// longer than the default, as a slower machine takes seconds over a test with several such pages.
const WHOLE_PAGE_TIMEOUT_MS = 30_000;
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

describe("the activity panels", { timeout: WHOLE_PAGE_TIMEOUT_MS }, () => {
  const TRUST =
    "Last reconciled 4 Nov 2026, 05:30 UTC. Nothing newer has reached this page, so it may be out of date.";
  const expected = expectedFromDataset(at(releaseGrade()));
  const main = plantedRealMain(expected, TRUST);
  const page = (body: string) =>
    `<!doctype html><html data-dataset-kind="real" data-dataset-version="${expected.version}" data-freshness="stale"><head><title>Open USD Monitor</title></head><body>
    ${PLANTED_HEADER}${plantedFlight([])}${body}
    ${plantedFooter(false, { fresh: null, stale: TRUST, short: "Last reconciled 4 Nov" })}</body></html>`;
  const check = (body: string) =>
    verifyOutput(site({ main: page(body), methodology: page("<main>Fine</main>") }), expected);
  const inPanel = (id: string, value: string, change: (panel: string) => string) => {
    const box = main.indexOf(`id="${id}"`);
    const start = main.indexOf(`data-chain-panel="${value}"`, box);
    const ends = [
      main.indexOf('<div data-chain-panel="', start + 1),
      main.indexOf('<div id="', start),
    ];
    const end = Math.min(...ends.filter((at) => at !== -1));
    return `${main.slice(0, start)}${change(main.slice(start, end))}${main.slice(end)}`;
  };
  const faults = (body: string, id: string, value: string) =>
    check(body).filter((problem: string) => problem.includes(`the ${value} panel of #${id}`));
  const W = CARD_ANCHORS.waterfall;
  const K = CARD_ANCHORS.weekly;

  it("passes the page the dataset calls for, with a panel per option for both cards", () => {
    expect(expected.waterfallPanels).toHaveLength(5);
    expect(expected.weeklyPanels).toHaveLength(5);
    expect(check(main)).toEqual([]);
  });

  it("pins the small-ticket note under All and Tempo, and no other chain", () => {
    const kinds = (value: string) =>
      expected.waterfallPanels
        .find((panel: { value: string }) => panel.value === value)!
        .notes.map((note: { kind: string }) => note.kind);
    expect(kinds("all")).toContain("small-ticket");
    expect(kinds("tempo")).toContain("small-ticket");
    for (const value of ["ethereum", "base", "solana"]) {
      expect(kinds(value)).not.toContain("small-ticket");
    }
  });

  it("refuses a waterfall panel that isn't the dataset's", () => {
    const heading = inPanel(W, "base", (html) =>
      html.replace(/<h2>[^<]*<\/h2>/, "<h2>Other.</h2>"),
    );
    expect(faults(heading, W, "base")).toContain(
      `index.html: the base panel of #${W}: its heading isn't the dataset's`,
    );
    const figure = inPanel(W, "base", (html) =>
      html.replace(/(<li data-step="burned">.*?<span class="tabular-nums">)[^<]*/, "$1−$9"),
    );
    expect(faults(figure, W, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("its rows aren't the dataset's")]),
    );
    // A marker moved to the next row keeps its order, but points at another row.
    const moved = inPanel(W, "tempo", (html) =>
      html.replace(
        /(<li data-step="clean_large"><span>S)(<sup class="fn-refs" data-fn-refs>.*?<\/sup>)(<\/span>.*?<li data-step="[^"]+"><span>S)/,
        "$1$3$2",
      ),
    );
    expect(faults(moved, W, "tempo")).toContain(
      `index.html: the tempo panel of #${W}: its hops marker isn't on clean_large`,
    );
    // The row's marker gone, though its footnote stays.
    const lost = inPanel(W, "tempo", (html) =>
      html.replace(
        /(data-step="issuer_flows"><span>S)<sup class="fn-refs" data-fn-refs><a [^>]*data-note="small-ticket"[^>]*>\d+<\/a><\/sup>/,
        "$1",
      ),
    );
    expect(lost).not.toBe(main);
    expect(faults(lost, W, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("small-ticket footnote hasn't one marker")]),
    );
    const full = inPanel(W, "all", (html) =>
      html.replace(/<p data-full-note="small-ticket">.*?<\/p>/, ""),
    );
    expect(faults(full, W, "all")).toEqual(
      expect.arrayContaining([expect.stringContaining("lost the small-ticket note in full")]),
    );
    const cell = inPanel(W, "base", (html) =>
      html.replace(/(<td data-label="Clean large">)[^<]*/, "$1$9"),
    );
    expect(faults(cell, W, "base")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("its table's Clean large isn't the dataset's"),
      ]),
    );
  });

  it("refuses a weekly panel that isn't the dataset's", () => {
    const bar = inPanel(K, "solana", (html) =>
      html.replace(/(<span data-week-value>)[^<]*/, "$1$9"),
    );
    expect(faults(bar, K, "solana")).toEqual(
      expect.arrayContaining([expect.stringContaining("its bars aren't the dataset's")]),
    );
    // Its notes are about the whole card, so markers moved into the chart fail.
    const moved = inPanel(K, "solana", (html) => {
      const marks = /<sup class="fn-refs" data-fn-refs>.*?<\/sup>/.exec(html)![0];
      return html
        .replace(marks, "")
        .replace('<div class="chart-area" aria-hidden="true">', `$&<p>${marks}</p>`);
    });
    expect(faults(moved, K, "solana")).toContain(
      `index.html: the solana panel of #${K}: its everyday-meaning marker isn't on the card's title`,
    );
    const note = inPanel(K, "solana", (html) => html.replace("nothing more.", "or so."));
    expect(faults(note, K, "solana")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("everyday-meaning footnote doesn't keep its words"),
      ]),
    );
    const marker = inPanel(K, "solana", (html) =>
      html.replace(
        /(<li id="[^"]*" data-note="history">)/,
        '$1<span class="status-chip" data-kind="fact">F</span> ',
      ),
    );
    // A marker is gone from the page, so planting one back fails the page, wherever it is.
    expect(check(marker)).toContain("index.html: a marker is back on the main page");
    const hidden = inPanel(K, "solana", (html) =>
      html.replace(
        /<details class="footnotes".*?<\/details>/,
        "<details><summary>More</summary>$&</details>",
      ),
    );
    expect(hidden).not.toBe(main);
    expect(check(hidden)).toContain("index.html: footnotes inside a details, noscript or tooltip");
    const opened = inPanel(K, "solana", (html) =>
      html.replace('<details class="footnotes"', '<details open class="footnotes"'),
    );
    expect(check(opened)).toContain("index.html: a card's footnotes are open by default");
  });
});
