import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DatasetLimits,
  datasetLimitText,
  ExtraLimits,
  NamedLabelsCard,
  SettingsCard,
  SourceLegend,
  Ticks,
  UnnamedClusters,
} from "@/components/methodology-tables";
import { loadDataset } from "@/lib/dataset/load";
import { UNKNOWN_TEXT } from "@/lib/format";
import {
  clusterTotals,
  EXTRA_LIMITS,
  labelsTakeaway,
  MethodologyError,
  namedLabels,
  settingRows,
  settingsTakeaway,
} from "@/lib/methodology";
import { at, copySample } from "./dataset-helpers";

const sample = loadDataset(at(copySample("complete")));
const rowOf = (change: Record<string, unknown> = {}) => ({ ...sample.labels.data[0], ...change });

describe("namedLabels", () => {
  it("has a row for every named entity, sorted by entity", () => {
    const rows = namedLabels(sample.labels.data);
    expect(rows.length).toBe(sample.labels.data.length);
    const entities = rows.map((row) => row.entity);
    expect(entities).toEqual([...entities].sort((a, b) => a.localeCompare(b)));
  });

  it("stops on a source that isn't https, and doesn't drop the row", () => {
    for (const source_url of [
      "javascript:alert(1)",
      "http://example.com/a",
      "data:text/html,x",
      "not a url",
      "https://user:pw@example.com/a",
    ]) {
      expect(() => namedLabels([rowOf({ source_url })])).toThrow(MethodologyError);
    }
  });

  it("lets a derived_rule row through, as it points at a rule and is never linked or listed", () => {
    const derived = rowOf({ source_type: "derived_rule", source_url: "labels/README.md" });
    const rows = namedLabels([derived, rowOf()]);
    expect(rows.length).toBe(1);
    expect(rows[0].sourceType).not.toBe("derived_rule");
  });

  it("takes its takeaway from the rows, and says so when there are none", () => {
    expect(labelsTakeaway([])).toBe(UNKNOWN_TEXT);
    expect(labelsTakeaway(namedLabels([rowOf()]))).toBe(
      "1 named label on 1 entity, each with a public source you can open",
    );
    expect(labelsTakeaway(namedLabels(sample.labels.data))).toMatch(
      /^\d+ named labels on \d+ entities/,
    );
  });
});

describe("NamedLabelsCard", () => {
  it("shows entity, category, source type, a safe source link and the date, per row", () => {
    const { container } = render(
      <NamedLabelsCard
        labels={sample.labels.data}
        state={sample.state}
        fallbackAsOf="2026-11-04T00:00:00Z"
      />,
    );
    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBe(sample.labels.data.length);
    const first = within(rows[0] as HTMLElement);
    const link = first.getByRole("link");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("href")).toMatch(/^https:\/\//);
    expect(link.textContent).not.toContain("https://");
    expect(rows[0].textContent).toMatch(/2026/);
    expect(container.querySelector("[data-labels-table]")).not.toBeNull();
  });

  it("has a card's parts, and the sample word", () => {
    const { container } = render(
      <NamedLabelsCard
        labels={sample.labels.data}
        state={sample.state}
        fallbackAsOf="2026-11-04T00:00:00Z"
      />,
    );
    const card = container.querySelector(".chart-card")!;
    expect(card.getAttribute("data-frame")).toBe("Sample");
    const meta = card.querySelector(".chart-card__meta")!;
    expect(meta.textContent).toContain("Source:");
    expect(meta.querySelector("time[datetime]")).not.toBeNull();
    expect(meta.querySelector('a[href*="#named-labels"]')).not.toBeNull();
    expect(screen.getByRole("heading", { level: 3 })).toBeTruthy();
  });

  it("says there is not enough data when there are no labels, and uses the fallback day", () => {
    const { container } = render(
      <NamedLabelsCard labels={[]} state={sample.state} fallbackAsOf="2026-11-04T00:00:00Z" />,
    );
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(UNKNOWN_TEXT);
    expect(container.querySelector("time")!.getAttribute("datetime")).toBe("2026-11-04T00:00:00Z");
  });
});

describe("UnnamedClusters", () => {
  it("counts by category with the rule, and never shows an address", () => {
    const { container } = render(<UnnamedClusters clusters={sample.labels.unnamed_clusters} />);
    const text = container.textContent!;
    expect(text).toContain("Redemption route");
    expect(text).toContain("Collection wallets take money from many senders");
    expect(text).not.toMatch(/0x[0-9a-fA-F]{4}/);
    expect(container.querySelectorAll("code").length).toBeGreaterThan(0);
    expect(text).not.toContain("`");
  });

  it("totals the chains of one category", () => {
    expect(
      clusterTotals([
        { chain: "base", category: "issuer_route", count: 1 },
        { chain: "tempo", category: "issuer_route", count: 2 },
        { chain: "ethereum", category: "system", count: 4 },
      ]),
    ).toEqual([
      { category: "issuer_route", total: 3, byChain: "Tempo 2, Base 1" },
      { category: "system", total: 4, byChain: "Ethereum 4" },
    ]);
  });

  it("says so when there are none, and still gives the rule", () => {
    const { container } = render(
      <UnnamedClusters clusters={{ ...sample.labels.unnamed_clusters, counts: [] }} />,
    );
    expect(container.textContent).toContain(UNKNOWN_TEXT);
    expect(container.querySelector("[data-unnamed-rule]")!.textContent).not.toBe("");
  });
});

describe("SourceLegend", () => {
  it("is inside data-source-legend, with a row per source type and the reading note", () => {
    const { container } = render(<SourceLegend legend={sample.labels.source_legend} />);
    const legend = container.querySelector("[data-source-legend]")!;
    expect(legend.querySelectorAll("tbody tr").length).toBe(
      sample.labels.source_legend.source_types.length,
    );
    expect(legend.textContent).toContain("Reading a label:");
  });
});

describe("Ticks", () => {
  it("turns backticks into code, and shows no backtick", () => {
    const { container } = render(<Ticks text="Use `labels/labels.csv` here" />);
    expect(container.querySelector("code")!.textContent).toBe("labels/labels.csv");
    expect(container.textContent).toBe("Use labels/labels.csv here");
  });
});

describe("limits", () => {
  it("gives a measured day to a dataset limit that has one", () => {
    const lost = sample.summary.known_limits.find(
      (limit) => limit.id === "lost_transfer_can_pass",
    )!;
    expect(datasetLimitText(lost)).toContain("(measured 2026-11-04)");
    const plain = sample.summary.known_limits.find((limit) => limit.id === "wallets_not_people")!;
    expect(datasetLimitText(plain)).toBe(plain.text);
  });

  it("lists all of a dataset's limits, conditional ones too", () => {
    const { container } = render(<DatasetLimits limits={sample.summary.known_limits} />);
    expect(container.querySelectorAll("li").length).toBe(sample.summary.known_limits.length);
  });

  it("lists every limit the dataset doesn't carry, with its day", () => {
    const { container } = render(<ExtraLimits />);
    expect(container.querySelectorAll("tbody tr").length).toBe(EXTRA_LIMITS.length);
    expect(container.textContent).toContain("2026-11-04");
  });
});

describe("settings", () => {
  it("reads the documented defaults as the same", () => {
    const rows = settingRows(sample.manifest.definitions);
    expect(rows.every((row) => row.same)).toBe(true);
    expect(settingsTakeaway(rows)).toBe("This dataset was built with the documented defaults");
  });

  it("flags a setting that differs", () => {
    const other = JSON.parse(JSON.stringify(sample.manifest.definitions));
    other.placed_days = 7;
    const rows = settingRows(other);
    expect(rows.find((row) => row.name === "placed_days")).toMatchObject({
      same: false,
      value: "7",
      documented: "14",
    });
    expect(settingsTakeaway(rows)).toContain("differ");
  });

  it("shows an amount as base units and as dollars, as strings throughout", () => {
    const { container } = render(<SettingsCard manifest={sample.manifest} state={sample.state} />);
    expect(container.textContent).toContain("1000000000000");
    expect(container.textContent).toContain("$1,000,000");
    expect(container.querySelector(".chart-card")!.getAttribute("data-frame")).toBe("Sample");
  });

  it("has no takeaway to give without rows", () => {
    expect(settingsTakeaway([])).toBe(UNKNOWN_TEXT);
  });
});
