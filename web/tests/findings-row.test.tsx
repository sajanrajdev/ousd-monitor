import { rmSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { FindingsRow } from "@/components/findings-row";
import { KpiRow } from "@/components/kpi-row";
import { loadDataset, type Dataset } from "@/lib/dataset/load";
import { CARD_ANCHORS } from "@/lib/definitions";
import {
  waterfall,
  waterfallHeading,
  weeklyEveryday,
  weeklyHeading,
} from "@/lib/takeaways/activity";
import { chainRolesHeading } from "@/lib/takeaways/chain-roles";
import { journeyHeading } from "@/lib/takeaways/journey";
import { at, copySample, editJson, releaseGrade } from "./dataset-helpers";

const SOON = Date.parse("2026-11-04T08:00:00Z");

const sample = (name: "complete" | "partial" = "complete") =>
  loadDataset(at(copySample(name)), { now: SOON });

function row(dataset: Dataset) {
  return render(
    <FindingsRow
      journey={dataset.journey}
      activity={dataset.activity}
      chain_roles={dataset.chain_roles}
      definitions={dataset.manifest.definitions}
      state={dataset.state}
    />,
  );
}

const links = (container: HTMLElement) => [...container.querySelectorAll("[data-finding-link]")];

describe("the findings row", () => {
  it("has four whole-card links, each with a heading's text and its marker", () => {
    const dataset = sample();
    const { container } = row(dataset);
    expect(container.querySelector('[data-section="findings"]')).not.toBeNull();
    const found = links(container);
    expect(found.map((link) => link.getAttribute("href"))).toEqual([
      `#${CARD_ANCHORS.supply}`,
      `#${CARD_ANCHORS.waterfall}`,
      `#${CARD_ANCHORS.weekly}`,
      `#${CARD_ANCHORS.chainRoles}`,
    ]);
    const { journey, activity, chain_roles, manifest } = dataset;
    const chains = ["tempo", "ethereum", "base", "solana"] as const;
    expect(found.map((link) => link.querySelector(".finding__text")!.textContent)).toEqual([
      journeyHeading(journey, manifest.definitions),
      waterfallHeading(waterfall(activity), [...chains]),
      weeklyHeading(weeklyEveryday(activity), [...chains]),
      chainRolesHeading(chain_roles),
    ]);
    for (const link of found) {
      expect(link.tagName).toBe("A");
      expect(link.querySelector(".status-chip .sr-only")!.textContent).toBe("Inferred");
    }
  });

  it("gives each link a name that holds the finding and the marker's word", () => {
    const { container } = row(sample());
    const [first] = links(container);
    const name = within(first as HTMLElement);
    expect(name.getByText("Inferred")).toBeTruthy();
    expect(first.textContent).toContain("of supply stayed");
  });

  it("on a sample, carries the word and the hatched edge on every card", () => {
    const { container } = row(sample());
    for (const link of links(container)) {
      expect(link.getAttribute("data-frame")).toBe("Sample");
      expect(link.querySelector(".chart-card__frame-word")!.textContent).toBe("Sample");
    }
  });

  it("on a preview, says Preview", () => {
    const dir = copySample("partial");
    rmSync(join(dir, "FIXTURE"));
    editJson(dir, "manifest.json", (manifest) => {
      manifest.git_commit = "abc1234";
    });
    const { container } = row(loadDataset(at(dir), { now: SOON }));
    for (const link of links(container)) {
      expect(link.getAttribute("data-frame")).toBe("Preview");
      expect(link.textContent).toContain("Preview");
    }
  });

  it("on real data, has no word or edge", () => {
    const { container } = row(loadDataset(at(releaseGrade()), { now: SOON }));
    for (const link of links(container)) {
      expect(link.hasAttribute("data-frame")).toBe(false);
      expect(link.querySelector(".chart-card__frame-word")).toBeNull();
    }
  });

  it("at partial scope, each names its chains and none says all chains", () => {
    const { container } = row(sample("partial"));
    for (const link of links(container)) {
      const text = link.querySelector(".finding__text")!.textContent!;
      expect(text.startsWith("On Tempo and Ethereum, ")).toBe(true);
      expect(text).not.toMatch(/all (four )?chains/i);
    }
  });

  it.each(["complete", "partial"] as const)(
    "%s: the placed share in the KPI, the finding and verdict.text agree",
    (name) => {
      const dataset = sample(name);
      const kpi = render(<KpiRow kpis={dataset.summary.kpis} state={dataset.state} />).container;
      const placed = [...kpi.querySelectorAll("dl > div")]
        .find((cell) => cell.querySelector("dt")!.textContent === "Placed share")!
        .querySelector("[data-kpi-value]")!.textContent!;
      const finding = links(row(dataset).container)[0].querySelector(
        ".finding__text",
      )!.textContent!;
      expect(finding).toContain(`${placed} of supply stayed`);
      const stated = /(\d+)% of supply has sat still/.exec(dataset.summary.verdict.text)![1];
      expect(String(Math.floor(Number.parseFloat(placed)))).toBe(stated);
    },
  );

  it("shows the unknown text, never a zero, when the data is gone", () => {
    const dataset = sample();
    const { container } = row({ ...dataset, journey: [], activity: [], chain_roles: [] });
    for (const link of links(container)) {
      expect(link.querySelector(".finding__text")!.textContent).toBe("Not enough data yet");
    }
  });

  it("names no exchange, and no entity at all", () => {
    const { container } = row(sample());
    expect(container.textContent).not.toMatch(/exchange/i);
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <main>
        <FindingsRow
          journey={sample().journey}
          activity={sample().activity}
          chain_roles={sample().chain_roles}
          definitions={sample().manifest.definitions}
          state={sample().state}
        />
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });
});
