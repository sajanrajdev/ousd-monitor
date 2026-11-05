import { rmSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FooterStatus, ReconciliationDetail, TrustStrip } from "@/components/trust-strip";
import { loadDataset, type Dataset } from "@/lib/dataset/load";
import { at, copySample, editJson, releaseGrade, type Json } from "./dataset-helpers";

const HOUR = 60 * 60 * 1000;
const GENERATED = Date.parse("2026-11-04T06:00:00Z");
const FRESH_SENTENCE = "Supply reconciled on all 4 chains as of";

// The detail page's content, which the trust row's disclosure used to hold.
function strip(dataset: Dataset) {
  return render(
    <ReconciliationDetail
      reconciliation={dataset.reconciliation}
      latest_run={dataset.latest_run}
      checks={dataset.manifest.checks}
      state={dataset.state}
    />,
  ).container;
}

const top = (dataset: Dataset) => render(<TrustStrip state={dataset.state} />).container;
const footer = (dataset: Dataset) => render(<FooterStatus state={dataset.state} />).container;
const shown = (container: HTMLElement, part: "fresh" | "stale") =>
  [...container.querySelectorAll(`.freshness-text__${part}`)].map((el) => el.textContent).join(" ");

function real(change?: (manifest: Json) => void, now = GENERATED + 2 * HOUR): Dataset {
  const dir = releaseGrade();
  if (change) editJson(dir, "manifest.json", change);
  return loadDataset(at(dir), { now });
}

describe("the trust row at the top of the main page", () => {
  it("is gone on a build that passed, as the footer says Reconciled", () => {
    expect(top(real()).querySelector('[data-section="trust-strip"]')).toBeNull();
  });

  it("stays, dated, on a build that's stale, and links to the detail page", () => {
    const container = top(real(undefined, GENERATED + 40 * HOUR));
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("Last reconciled 4 Nov 2026, 05:30 UTC.");
    expect(container.querySelector('a[href="/reconciliation/"]')).not.toBeNull();
  });

  it("stays on a sample, saying not reconciled", () => {
    const container = top(loadDataset(at(copySample("complete")), { now: GENERATED + HOUR }));
    expect(container.textContent).toContain("Not reconciled");
    expect(container.textContent).not.toContain(FRESH_SENTENCE);
  });

  it("stays when a newer run failed its checks", () => {
    const container = top(
      real((manifest) => {
        manifest.stale = true;
        manifest.stale_since = "2026-11-04T07:00:00Z";
        manifest.stale_reason = "internal detail";
      }),
    );
    expect(container.textContent).toContain("A newer run did not pass its checks.");
  });
});

describe("the footer's status", () => {
  it("passing: a tick and the word Reconciled, with the full sentence as its tooltip", () => {
    const container = footer(real());
    const word = container.querySelector(".freshness-text__fresh [data-reconciled]")!;
    const link = word.querySelector("a")!;
    // The word and the tick are the link, and the sentence is its tooltip, not part of its name.
    expect(link.textContent).toBe("✓ Reconciled");
    expect(link.querySelector('[aria-hidden="true"]')!.textContent).toBe("✓");
    expect(link.getAttribute("href")).toBe("/reconciliation/");
    const tip = document.getElementById(link.getAttribute("aria-describedby")!)!;
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toBe(`${FRESH_SENTENCE} 4 Nov 2026, 05:30 UTC`);
    // If the reader's clock finds it old, the swap says so in place, and not in green.
    expect(shown(container, "stale")).toContain("Last reconciled 4 Nov 2026, 05:30 UTC.");
    expect(container.querySelector(".freshness-text__stale [data-reconciled]")).toBeNull();
  });

  it.each([
    ["stale by the clock", () => real(undefined, GENERATED + 40 * HOUR)],
    [
      "a failed newer run",
      () =>
        real((manifest) => {
          manifest.stale = true;
          manifest.stale_since = "2026-11-04T07:00:00Z";
          manifest.stale_reason = "internal detail";
        }),
    ],
    ["a sample", () => loadDataset(at(copySample("complete")), { now: GENERATED + HOUR })],
    [
      "a preview",
      () => {
        const dir = copySample("partial");
        editJson(dir, "manifest.json", (manifest) => {
          manifest.git_commit = "abc1234";
        });
        rmSync(join(dir, "FIXTURE"));
        return loadDataset(at(dir), { now: GENERATED + HOUR });
      },
    ],
  ])("never says Reconciled on %s", (_, dataset) => {
    const container = footer(dataset());
    expect(container.querySelector("[data-reconciled]")).toBeNull();
    expect(container.textContent).not.toMatch(/\bReconciled\b/);
    expect(container.textContent).not.toContain(FRESH_SENTENCE);
    expect(container.querySelector('a[href="/reconciliation/"]')).not.toBeNull();
  });
});

describe("the footer's status on a sample or preview", () => {
  it("is one text, outside the fresh and stale swap, so a fresh sample still shows it", () => {
    const dataset = loadDataset(at(copySample("complete")), { now: GENERATED + HOUR });
    expect(dataset.state.freshness).toBe("fresh");
    const container = footer(dataset);
    expect(container.querySelector(".freshness-text")).toBeNull();
    expect(container.textContent).toBe("○ Not reconciled");
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });
});

describe("the reconciliation detail", () => {
  it("holds the state, the words and table, and no disclosure or tooltip", () => {
    const container = strip(real());
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("[data-tip]")).toBeNull();
    expect(container.querySelector(".trust-strip__status")!.textContent).toContain(FRESH_SENTENCE);
    for (const piece of [
      "What this covers",
      "It doesn't verify placed share or velocity.",
      "Checks before this data was published",
    ]) {
      expect(container.textContent).toContain(piece);
    }
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector('a[href$="#reconciliation"]')).not.toBeNull();
  });

  it("fresh: the dated sentence is shown, with a tick", () => {
    const container = strip(real());
    expect(
      [...container.querySelectorAll(".freshness-text__fresh")]
        .map((el) => el.textContent)
        .join(" "),
    ).toContain(`${FRESH_SENTENCE} 4 Nov 2026, 05:30 UTC`);
    expect(container.textContent).toContain("✓");
  });

  it("stale by the clock: the fresh sentence is only in the swapped-out text", () => {
    const dataset = real(undefined, GENERATED + 40 * HOUR);
    const container = strip(dataset);
    expect(container.textContent).not.toContain(FRESH_SENTENCE);
    expect(container.textContent).toContain("Last reconciled 4 Nov 2026, 05:30 UTC.");
    expect(container.textContent).toContain("Nothing newer has reached this page");
    expect(container.textContent).toContain("▲");
  });

  it("manifest.stale: says a newer run did not pass its checks", () => {
    const container = strip(
      real((manifest) => {
        manifest.stale = true;
        manifest.stale_since = "2026-11-04T07:00:00Z";
        manifest.stale_reason = "internal detail";
      }),
    );
    expect(container.textContent).toContain("A newer run did not pass its checks.");
    expect(container.textContent).not.toContain(FRESH_SENTENCE);
    expect(container.textContent).not.toContain("internal detail");
  });

  it("preview: says not reconciled, never the fresh sentence", () => {
    const dir = copySample("partial");
    editJson(dir, "manifest.json", (manifest) => {
      manifest.git_commit = "abc1234";
    });
    rmSync(join(dir, "FIXTURE"));
    const dataset = loadDataset(at(dir), { now: GENERATED + HOUR });
    expect(dataset.state.kind).toBe("preview");
    const container = strip(dataset);
    expect(container.textContent).toContain("Not reconciled");
    expect(container.textContent).not.toContain(FRESH_SENTENCE);
    expect(container.textContent).toContain("Preview figures, not a reconciliation.");
    expect(container.textContent).toContain("○");
  });

  it("sample: says not reconciled and frames the detail", () => {
    const dataset = loadDataset(at(copySample("complete")), { now: GENERATED + HOUR });
    const container = strip(dataset);
    expect(container.textContent).toContain("Not reconciled");
    expect(container.textContent).not.toContain(FRESH_SENTENCE);
    expect(container.textContent).toContain("Sample figures, not a reconciliation.");
  });

  it("fresh appears only in fresh", () => {
    const states = [
      strip(real(undefined, GENERATED + 40 * HOUR)),
      strip(loadDataset(at(copySample("complete")), { now: GENERATED + HOUR })),
    ];
    for (const container of states) expect(container.textContent).not.toContain(FRESH_SENTENCE);
  });

  it("prints exact base-unit amounts, including a value above 2^53", () => {
    const big = "9007199254740993";
    const dataset = real();
    const rows = dataset.reconciliation.map((row) =>
      row.subject === "tempo" && row.kind === "chain"
        ? { ...row, event_value: big, reference_value: big, difference: "0" }
        : row,
    );
    const container = strip({ ...dataset, reconciliation: rows });
    expect(container.textContent).toContain("9,007,199,254,740,993");
    expect(container.textContent).not.toContain("9007199254740992");
  });

  it("lists each chain, then Bridge's comparison, from the latest run only", () => {
    const dataset = real();
    const stale = { ...dataset.reconciliation[1], run_id: "f".repeat(32), event_value: "1" };
    const container = strip({ ...dataset, reconciliation: [...dataset.reconciliation, stale] });
    const subjects = [...container.querySelectorAll("tbody tr")].map(
      (row) => row.querySelector("td")!.textContent,
    );
    expect(subjects).toEqual([
      "Tempo",
      "Ethereum",
      "Base",
      "Solana",
      "Bridge's reported total, all chains",
    ]);
  });

  it("says what reconciliation does not verify, and shows no pipeline detail", () => {
    const container = strip(real());
    expect(container.textContent).toContain("It doesn't verify placed share or velocity.");
    expect(container.textContent).toContain("close of the named day");
  });

  it("shows the unknown text when there is no latest run", () => {
    const dataset = real();
    const container = strip({ ...dataset, latest_run: null });
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("Not enough data yet");
  });
});
