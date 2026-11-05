import { describe, expect, it } from "vitest";
import { CARD_ANCHORS } from "@/lib/definitions";
import { expectedFromDataset, verifyOutput } from "@/scripts/verify-output.mjs";
import { at, plantFile, releaseGrade, tempDir } from "./dataset-helpers";
import { plantedFlight, plantedRealMain } from "./planted-first-screen";

// Each whole-page group is a file of its own, and so a worker of its own, as one worker running
// them all ran out of memory in CI.
// In a file of their own, so a worker of their own: each test parses a whole planted main page several
// times, which the heap of a file with hundreds of tests can't also hold. For the same reason they get
// longer than the default, as a slower machine takes seconds over a test with several such pages.
const WHOLE_PAGE_TIMEOUT_MS = 30_000;
const LINE = "Independent. Not affiliated with Open Standard or Bridge.";

function site({ main, methodology }: { main: string; methodology: string }) {
  const dir = tempDir();
  plantFile(dir, "index.html", main);
  plantFile(dir, "methodology/index.html", methodology);
  return dir;
}

describe("the activity panels", { timeout: WHOLE_PAGE_TIMEOUT_MS }, () => {
  const STALE =
    "Data from 4 Nov 2026, 06:00 UTC. Nothing newer has reached this page, so it may be out of date.";
  const TRUST =
    "Last reconciled 4 Nov 2026, 05:30 UTC. Nothing newer has reached this page, so it may be out of date.";
  const expected = expectedFromDataset(at(releaseGrade()));
  const main = plantedRealMain(expected, STALE, TRUST);
  const page = (body: string) =>
    `<!doctype html><html data-dataset-kind="real" data-dataset-version="${expected.version}" data-freshness="stale"><head><title>Open USD Monitor</title></head><body>
    <header><p>${LINE}</p></header><p data-stale-note>${STALE}</p>${plantedFlight([])}${body}
    <footer><p>${LINE}</p><p>Not financial advice.</p></footer></body></html>`;
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
    const pin = inPanel(W, "tempo", (html) =>
      html.replace(/(<li data-step="clean_large"><span>S)(<span class="pin">\d+<\/span>)/, "$1"),
    );
    expect(faults(pin, W, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("its pins are")]),
    );
    const lost = inPanel(W, "tempo", (html) =>
      html.replace(/<li data-note="small-ticket">.*?<\/li>/, ""),
    );
    expect(faults(lost, W, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("its notes are")]),
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
    const pins = inPanel(K, "solana", (html) =>
      html.replace(/<div data-chart-pins>.*?<\/div>/, "<div data-chart-pins></div>"),
    );
    expect(faults(pins, K, "solana")).toEqual(
      expect.arrayContaining([expect.stringContaining("its pins don't match its notes")]),
    );
    const note = inPanel(K, "solana", (html) => html.replace("nothing more.", "or so."));
    expect(faults(note, K, "solana")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("everyday-meaning note doesn't keep its words"),
      ]),
    );
    const marker = inPanel(K, "solana", (html) =>
      html.replace(
        /(<li data-note="history"><span class="pin" aria-hidden="true">\d+<\/span><p>)/,
        '$1<span class="status-chip" data-kind="fact">F</span> ',
      ),
    );
    expect(faults(marker, K, "solana")).toEqual(
      expect.arrayContaining([expect.stringContaining("history note's marker isn't absent")]),
    );
    const hidden = inPanel(K, "solana", (html) =>
      html.replace(
        /<ol data-pinned-notes>/,
        "<details><summary>More</summary><ol data-pinned-notes>",
      ),
    );
    expect(check(hidden).length).toBeGreaterThan(0);
  });
});
