import { rmSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrustStrip } from "@/components/trust-strip";
import { loadDataset, type Dataset } from "@/lib/dataset/load";
import { at, copySample, editJson, releaseGrade, type Json } from "./dataset-helpers";

const HOUR = 60 * 60 * 1000;
const GENERATED = Date.parse("2026-11-04T06:00:00Z");
const FRESH_SENTENCE = "Supply reconciled on all 4 chains as of";

function strip(dataset: Dataset) {
  return render(
    <TrustStrip
      reconciliation={dataset.reconciliation}
      latest_run={dataset.latest_run}
      checks={dataset.manifest.checks}
      coverage={dataset.manifest.coverage}
      state={dataset.state}
    />,
  ).container;
}

function real(change?: (manifest: Json) => void, now = GENERATED + 2 * HOUR): Dataset {
  const dir = releaseGrade();
  if (change) editJson(dir, "manifest.json", change);
  return loadDataset(at(dir), { now });
}

describe("the trust strip", () => {
  it("is one row: the state in view, and one disclosure holding the words and table", () => {
    const container = strip(real());
    const details = container.querySelectorAll("details");
    expect(details).toHaveLength(1);
    expect(details[0].querySelector("summary")!.textContent).toBe("Reconciliation detail");
    const status = container.querySelector(".trust-strip__status")!;
    expect(status.closest("details")).toBeNull();
    expect(status.textContent).toContain(FRESH_SENTENCE);
    for (const piece of [
      "What this covers",
      "It doesn't verify placed share or velocity.",
      "Checks before this data was published",
    ]) {
      expect(details[0].textContent).toContain(piece);
    }
    expect(details[0].querySelector("table")).not.toBeNull();
    expect(details[0].querySelector('a[href$="#reconciliation"]')).not.toBeNull();
  });

  it("is never a popover, as nothing here takes turns with one", () => {
    const container = strip(real());
    expect(container.querySelector(".info-popover")).toBeNull();
    expect(container.querySelector("details")!.hasAttribute("name")).toBe(false);
  });

  it("fresh: the dated sentence is shown, with a tick", () => {
    const container = strip(real());
    expect(
      [...container.querySelectorAll(".freshness-text__fresh")]
        .map((el) => el.textContent)
        .join(" "),
    ).toContain(`${FRESH_SENTENCE} 4 Nov 2026, 05:30 UTC`);
    expect(container.textContent).toContain("✓");
    expect(container.querySelector('a[href$="#reconciliation"]')).not.toBeNull();
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
