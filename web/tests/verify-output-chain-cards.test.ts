import { describe, expect, it } from "vitest";
import { expectedFromDataset, verifyOutput } from "@/scripts/verify-output.mjs";
import { at, editJson, plantFile, releaseGrade, tempDir } from "./dataset-helpers";
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

describe("the velocity chart and the chain grid", { timeout: WHOLE_PAGE_TIMEOUT_MS }, () => {
  const STALE =
    "Data from 4 Nov 2026, 06:00 UTC. Nothing newer has reached this page, so it may be out of date.";
  const TRUST =
    "Last reconciled 4 Nov 2026, 05:30 UTC. Nothing newer has reached this page, so it may be out of date.";
  const dir = releaseGrade();
  editJson(dir, "manifest.json", (manifest) => {
    manifest.warnings = [
      {
        chain: "base",
        metric: "circulating_supply",
        day: "2026-11-02",
        previous: "20000000000000",
        current: "10000000000000",
      },
    ];
  });
  const expected = expectedFromDataset(at(dir));
  const main = plantedRealMain(expected, STALE, TRUST);
  const page = (body: string) =>
    `<!doctype html><html data-dataset-kind="real" data-dataset-version="${expected.version}" data-freshness="stale"><head><title>Open USD Monitor</title></head><body>
    <header><p>${LINE}</p></header><p data-stale-note>${STALE}</p>${plantedFlight([])}${body}
    <footer><p>${LINE}</p><p>Not financial advice.</p></footer></body></html>`;
  const check = (body: string) =>
    verifyOutput(site({ main: page(body), methodology: page("<main>Fine</main>") }), expected);

  it("passes the page the dataset calls for, with the warning pinned beside its chain", () => {
    expect(expected.velocity.notes[0]).toMatchObject({ kind: "velocity-warning", chain: "base" });
    expect(check(main)).toEqual([]);
  });

  it("fails with the warning only in the popover, or its pin on another chain", () => {
    const moved = main.replace(/<li data-note="velocity-warning".*?<\/li>/, "");
    expect(check(moved)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "#velocity-by-chain: its notes are velocity-denominators:, not velocity-warning:base,",
        ),
      ]),
    );
    const elsewhere = main
      .replace(/(<p class="velocity-chart__name">base)<span class="pin">1<\/span>/, "$1")
      .replace(/(<p class="velocity-chart__name">tempo)/, '$1<span class="pin">1</span>');
    expect(check(elsewhere)).toEqual(
      expect.arrayContaining([expect.stringContaining("its chain pins are tempo=1, not base=1")]),
    );
  });

  it("fails on a bar that isn't the dataset's, or a caption that drops wallets, not people", () => {
    const bar = main.replace(/(<span data-velocity-value>)[^<]*/, "$19.99%");
    expect(check(bar)).toEqual(
      expect.arrayContaining([expect.stringContaining("its bars aren't the dataset's")]),
    );
    const caption = main.replace("Velocity. Wallets, not people.", "Velocity.");
    expect(check(caption)).toEqual(
      expect.arrayContaining([expect.stringContaining("doesn't say what a wallet is")]),
    );
  });

  it("fails when the popover loses a full note, or the denominators pin leaves its legend entry", () => {
    const full = main.replace(/<p data-full-note="velocity-denominators">.*?<\/p>/, "");
    expect(check(full)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lost the velocity-denominators note in full"),
      ]),
    );
    const pin = main.replace(/(Headline velocity)<span class="pin">\d+<\/span>/, "$1");
    expect(check(pin)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("the denominators pin isn't on the headline velocity legend"),
      ]),
    );
  });

  it("fails on a grid cell, bar or lead marker that isn't the dataset's", () => {
    const cell = main.replace(/(<span data-grid-value>)[^<]*/, "$19.99%");
    const lead = main.replace(/ data-leads>/, ">");
    const width = main.replace(/(chain-grid__bar" data-width=")\d+/, "$1123");
    for (const body of [cell, lead, width]) {
      expect(check(body)).toEqual(
        expect.arrayContaining([expect.stringContaining("its grid isn't the dataset's")]),
      );
    }
  });
});
