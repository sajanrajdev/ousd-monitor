import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
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
  it("shows four numbers, each with a definition and a link, and no marker", () => {
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
      expect(item.querySelector(".status-chip")).toBeNull();
      expect(item.querySelector("[data-kpi-value]")!.closest("details, .tip__panel")).toBeNull();
      const panel = item.querySelector(".tip__panel")!;
      expect(panel.querySelector("a")!.getAttribute("href")).toContain("/methodology/#");
      expect(panel.textContent).toContain("As of ");
    }
    expect(values(container)["Total supply"]).toBe("$13.1B");
    expect(container.textContent).not.toMatch(/active wallets/i);
  });

  it("keeps each note in its tooltip, with the words and the name to reach it", () => {
    const dataset = load();
    const { container } = render(<KpiRow kpis={dataset.summary.kpis} state={dataset.state} />);
    const placed = [...container.querySelectorAll("dl > div")][1];
    const trigger = placed.querySelector(".tip__trigger")!;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-label")).toBe("About: Placed share");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const panel = placed.querySelector(".tip__panel")!;
    expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.textContent).toContain(
      "Share of supply that has stayed in large wallets with no issuer, venue or system label, for the placed window.",
    );
    expect(placed.querySelector("details")).toBeNull();
    // Parsed as verify-output parses a built page, so the noscript's children are elements.
    const html = renderToStaticMarkup(<KpiRow kpis={dataset.summary.kpis} state={dataset.state} />);
    const link = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelectorAll("dl > div")[1]
      .querySelector("noscript a")!;
    expect(link.getAttribute("href")).toBe("/methodology/#placed-supply");
  });

  it("repeats no date in its visible line when the as-of line above covers it", () => {
    const dataset = load();
    const { container } = render(<KpiRow kpis={dataset.summary.kpis} state={dataset.state} />);
    const line = container.querySelector(".chart-card__meta")!.textContent!;
    expect(line).toContain("Across Tempo, Ethereum, Base, Solana.");
    expect(line).not.toContain("As of");
  });

  it("shows its own date if it ever differs from the line above, as the line wouldn't cover it", () => {
    const dataset = load();
    const days = dataset.summary.kpis.map((row) => ({ ...row, day: "2026-10-01" }));
    const { container } = render(<KpiRow kpis={days} state={dataset.state} />);
    expect(container.querySelector(".chart-card__meta")!.textContent).toContain(
      "As of 1 Oct 2026 UTC",
    );
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
