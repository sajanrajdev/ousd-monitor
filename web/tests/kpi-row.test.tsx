import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KpiRow } from "@/components/kpi-row";
import { loadDataset } from "@/lib/dataset/load";
import { at, copySample, editJson, type Json } from "./dataset-helpers";

const SOON = Date.parse("2026-11-04T08:00:00Z");

function load(name: "complete" | "partial" = "complete", change?: (kpis: Json[]) => void) {
  const dir = copySample(name);
  if (change) editJson(dir, "summary.json", (summary) => change(summary.kpis));
  return loadDataset(at(dir), { now: SOON });
}

function values(container: HTMLElement): Record<string, string> {
  return Object.fromEntries(
    [...container.querySelectorAll("dl > div")].map((item) => [
      item.querySelector("dt")!.textContent!,
      item.querySelector("[data-kpi-value]")!.textContent!,
    ]),
  );
}

describe("the KPI row", () => {
  it("shows four numbers, each with a chip, a definition and a link", () => {
    const dataset = load();
    const { container } = render(<KpiRow kpis={dataset.summary.kpis} state={dataset.state} />);
    const items = [...container.querySelectorAll("dl > div")];
    expect(items.map((item) => item.querySelector("dt")!.textContent)).toEqual([
      "Total supply",
      "Placed share",
      "7-day everyday volume",
      "Everyday velocity",
    ]);
    for (const item of items) {
      expect(item.querySelector(".status-chip")).not.toBeNull();
      expect(item.querySelector("a")!.getAttribute("href")).toContain("/methodology/#");
    }
    expect(values(container)["Total supply"]).toBe("$13.1B");
    expect(container.textContent).not.toMatch(/active wallets/i);
  });

  it("floors the placed share to the verdict's whole percent, with chains at different days", () => {
    for (const name of ["complete", "partial"] as const) {
      const dataset = load(name);
      const { container } = render(<KpiRow kpis={dataset.summary.kpis} state={dataset.state} />);
      const shown = values(container)["Placed share"];
      const whole = Math.floor(Number.parseFloat(shown));
      const stated = /(\d+)% of supply has sat still/.exec(dataset.summary.verdict.text)![1];
      expect(String(whole)).toBe(stated);
    }
    const complete = load();
    expect(new Set(complete.summary.kpis.map((row) => row.day)).size).toBeGreaterThan(1);
  });

  it("shows the unknown text for a null ratio, never zero", () => {
    const dataset = load();
    const { container } = render(<KpiRow kpis={dataset.summary.kpis} state={dataset.state} />);
    // Solana's everyday velocity is null in the sample, so the all-chain figure is too.
    expect(values(container)["Everyday velocity"]).toBe("Not enough data yet");
  });

  it("shows unknown for every figure when there are no rows", () => {
    const dataset = load();
    const { container } = render(<KpiRow kpis={[]} state={dataset.state} />);
    expect(Object.values(values(container))).toEqual(Array(4).fill("Not enough data yet"));
  });

  it("names the chains covered and keeps the frame word", () => {
    const dataset = load("partial");
    const { container } = render(<KpiRow kpis={dataset.summary.kpis} state={dataset.state} />);
    expect(container.textContent).toContain("Across Tempo, Ethereum");
    expect(container.querySelector("[data-frame-word]")!.textContent).toBe("Sample");
  });
});
