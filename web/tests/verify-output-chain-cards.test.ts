import { describe, expect, it } from "vitest";
import { expectedFromDataset, verifyOutput } from "@/scripts/verify-output.mjs";
import { at, editJson, plantFile, releaseGrade, tempDir } from "./dataset-helpers";
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

describe("the velocity chart and the chain grid", { timeout: WHOLE_PAGE_TIMEOUT_MS }, () => {
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
  const main = plantedRealMain(expected, TRUST);
  const page = (body: string) =>
    `<!doctype html><html data-dataset-kind="real" data-dataset-version="${expected.version}" data-freshness="stale"><head><title>Open USD Monitor</title></head><body>
    ${PLANTED_HEADER}${plantedFlight([])}${body}
    ${plantedFooter(false, { fresh: null, stale: TRUST, short: "Last reconciled 4 Nov" })}</body></html>`;
  const check = (body: string) =>
    verifyOutput(site({ main: page(body), methodology: page("<main>Fine</main>") }), expected);

  it("passes the page the dataset calls for, with the warning's marker on its chain", () => {
    expect(expected.velocity.notes[0]).toMatchObject({ kind: "velocity-warning", chain: "base" });
    expect(check(main)).toEqual([]);
  });

  it("fails with the warning's marker gone, or moved off its chain", () => {
    const gone = main.replace(
      /(<p class="velocity-chart__name">base)<sup class="fn-refs" data-fn-refs>.*?<\/sup>/,
      "$1",
    );
    expect(gone).not.toBe(main);
    expect(check(gone)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "#velocity-by-chain: its velocity-warning footnote hasn't one marker numbered 2",
        ),
      ]),
    );
    // Beside another chain's name, its marker points at the wrong chain.
    const marker =
      /(<p class="velocity-chart__name">base)(<sup class="fn-refs" data-fn-refs>.*?<\/sup>)/.exec(
        main,
      )!;
    const moved = main
      .replace(marker[0], marker[1])
      .replace(/(<p class="velocity-chart__name">solana)/, `$1${marker[2]}`);
    expect(check(moved)).toContain(
      "index.html: #velocity-by-chain: its velocity-warning marker isn't on base",
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

  it("fails when the tooltip loses a full note, or a marker is put on a headline row", () => {
    const full = main.replace(/<p data-full-note="velocity-denominators">.*?<\/p>/, "");
    expect(check(full)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lost the velocity-denominators note in full"),
      ]),
    );
    // The denominators note is about the whole card, so its marker on a headline row fails.
    const head =
      /<div class="chart-card__head"><h2>[^<]*<\/h2>(<sup class="fn-refs" data-fn-refs>.*?<\/sup>)/;
    const own = head.exec(main.slice(main.indexOf('id="velocity-by-chain"')))![1];
    const start = main.indexOf('id="velocity-by-chain"');
    const card = main.slice(start);
    const moved = `${main.slice(0, start)}${card
      .replace(own, "")
      .replace(
        /(<div data-measure="headline_velocity_bps"><span class="velocity-chart__label">M)/,
        `$1${own}`,
      )}`;
    expect(moved).not.toBe(main);
    expect(check(moved)).toContain(
      "index.html: #velocity-by-chain: its velocity-denominators marker isn't on the card's title",
    );
    expect(main).not.toContain("data-velocity-legend");
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
