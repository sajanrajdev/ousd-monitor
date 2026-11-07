import { render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VelocityCard } from "@/components/views/velocity";
import { velocityChart } from "@/lib/chain-views";
import { getDataset } from "@/lib/dataset";
import { UNKNOWN_TEXT } from "@/lib/format";
import { velocityHeading } from "@/lib/takeaways/activity";

const WARNING = {
  chain: "ethereum" as const,
  metric: "circulating_supply",
  day: "2026-11-03",
  previous: "6405808717650",
  current: "2837423707650",
};

function mount(edit?: (props: Parameters<typeof VelocityCard>[0]) => void) {
  vi.stubEnv("OUSD_DATASET_DIR", "fixtures/dataset/complete");
  const { summary, manifest, state } = getDataset();
  const props = {
    kpis: structuredClone(summary.kpis),
    definitions: manifest.definitions,
    warnings: structuredClone(manifest.warnings),
    state,
  };
  edit?.(props);
  return render(<VelocityCard {...props} />);
}

// Each marker in reading order, with its number and the words of the footnote it links to.
const notesOf = (container: HTMLElement) =>
  [...container.querySelectorAll("a[data-fn-ref]")].map((marker) => ({
    kind: marker.getAttribute("data-note"),
    chain: marker.getAttribute("data-chain"),
    pin: marker.textContent,
    text: container.querySelector(marker.getAttribute("href")!.replace(/:/g, "\\:"))!.textContent,
  }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("velocity by chain", () => {
  it("draws three bars a chain, in the static HTML, with a figure on each", () => {
    const { container } = mount();
    const groups = [...container.querySelectorAll("[data-velocity-chain]")];
    expect(groups.map((group) => group.getAttribute("data-velocity-chain"))).toEqual([
      "tempo",
      "ethereum",
      "base",
      "solana",
    ]);
    for (const group of groups) {
      expect(
        [...group.querySelectorAll("[data-measure]")].map((row) =>
          row.getAttribute("data-measure"),
        ),
      ).toEqual(["velocity_bps", "velocity_everyday_bps", "headline_velocity_bps"]);
    }
    const base = container.querySelector('[data-velocity-chain="base"]')!;
    expect(
      base.querySelector('[data-measure="velocity_bps"] [data-velocity-value]')!.textContent,
    ).toBe("42.85%");
    // The card's clock is the only drawing outside the chart, and the chart has none.
    expect(container.querySelector(".chart-area svg, canvas, .recharts-wrapper")).toBeNull();
  });

  it("scales every bar on one linear axis from zero to the largest figure", () => {
    vi.stubEnv("OUSD_DATASET_DIR", "fixtures/dataset/complete");
    const { summary } = getDataset();
    const chart = velocityChart(summary.kpis, []);
    const all = chart.groups.flatMap((group) => group.bars);
    const largest = Math.max(...all.map((bar) => bar.bps ?? 0));
    expect(chart.max).toBe(largest);
    expect(all.filter((bar) => bar.widthBps === 10_000)).toHaveLength(1);
    for (const bar of all) {
      expect(bar.widthBps).toBe(bar.bps === null ? null : Math.floor((bar.bps * 10_000) / largest));
    }
  });

  it("puts a warning's marker on its chain's name, names its chain in words, and moves it with the warning", () => {
    const { container } = mount((props) => {
      props.warnings = [WARNING];
    });
    // The footnote markers are the card's one set: nothing in the chart is a pin.
    expect(container.querySelector(".chart-area .pin")).toBeNull();
    const notes = notesOf(container);
    // The note about the whole card is first, on the title, then the chain's.
    expect(notes[0]).toMatchObject({ kind: "velocity-denominators", pin: "1" });
    expect(notes[1]).toMatchObject({ kind: "velocity-warning", chain: "ethereum", pin: "2" });
    expect(notes[1].text).toContain("Ethereum, 3 Nov 2026 UTC");
    expect(notes[1].text).toContain("$6.4M");
    expect(notes[1].text).toContain("$2.8M");
    expect(notes[1].text).toContain("unusually high");
    expect(notes[1].text).toContain("shouldn't be read as a trend");
    const name = container.querySelector('[data-velocity-chain="ethereum"] .velocity-chart__name')!;
    expect(name.querySelector('[data-note="velocity-warning"]')).not.toBeNull();
    expect(
      container.querySelector('.chart-card__head [data-note="velocity-denominators"]'),
    ).not.toBeNull();
    // The marker is a link inside the chart, so the chart is read, not hidden.
    expect(container.querySelector(".chart-area")!.hasAttribute("aria-hidden")).toBe(false);
    const moved = mount((props) => {
      props.warnings = [{ ...WARNING, chain: "base" }];
    });
    expect(notesOf(moved.container)[1]).toMatchObject({ chain: "base", pin: "2" });
    expect(notesOf(moved.container)[1].text).toContain("Base, 3 Nov 2026 UTC");
    expect(
      moved.container.querySelector('[data-velocity-chain="base"] [data-note="velocity-warning"]'),
    ).not.toBeNull();
  });

  it("has no gap without a warning, no pin in the chart, and numbers two warnings in chart order", () => {
    const none = mount((props) => {
      props.warnings = [{ ...WARNING, metric: "total_supply" }];
    });
    expect(notesOf(none.container)).toEqual([
      expect.objectContaining({ kind: "velocity-denominators", pin: "1" }),
    ]);
    expect(none.container.querySelectorAll("[data-velocity-chain] .pin")).toHaveLength(0);
    expect(none.container.querySelectorAll("a[data-fn-ref]")).toHaveLength(1);
    expect(none.container.querySelectorAll(".footnotes__list > li")).toHaveLength(1);
    expect(none.container.querySelector("[data-velocity-legend]")).toBeNull();
    none.unmount();
    const two = mount((props) => {
      props.warnings = [
        { ...WARNING, chain: "solana" },
        { ...WARNING, chain: "tempo" },
      ];
    });
    expect(notesOf(two.container).map(({ chain, pin }) => `${chain}:${pin}`)).toEqual([
      "null:1",
      "tempo:2",
      "solana:3",
    ]);
  });

  it("keeps each warning whole, and the denominators and jumpy notes, in the popover", () => {
    const { container } = mount((props) => {
      props.warnings = [WARNING];
    });
    const panel = container.querySelector(".chart-card__head > .tip--info > .tip__panel")!;
    expect(
      panel.querySelector('[data-full-note="velocity-warning"][data-chain="ethereum"]')!
        .textContent,
    ).toContain("Ethereum's circulating supply, which its velocity divides by, moved sharply");
    expect(panel.querySelector('[data-full-note="velocity-denominators"]')!.textContent).toContain(
      "They aren't two cuts of one number.",
    );
    expect(panel.querySelector('a[href="/methodology/#velocity"]')).not.toBeNull();
    expect(panel.querySelector('[data-full-note="velocity-jumpy"]')!.textContent).toMatch(
      /small circulating supply makes velocity jumpy/,
    );
    const marker = container.querySelector('a[data-fn-ref][data-note="velocity-denominators"]')!;
    expect(marker.closest("details, noscript")).toBeNull();
  });

  it("names the chains where velocity beats headline velocity, or says none do", () => {
    const { container } = mount();
    expect(container.querySelector("h2")!.textContent).toBe(
      "On Base, velocity is higher than headline velocity.",
    );
    const { summary } = getDataset();
    expect(velocityHeading(summary.kpis.map((row) => ({ ...row, velocity_bps: 0 })))).toBe(
      "Velocity is no higher than headline velocity on any chain with a figure.",
    );
  });

  it("shows the unknown text and no bar for a null figure, and no chart when all are null", () => {
    const { container } = mount((props) => {
      for (const row of props.kpis.filter((r) => r.chain === "solana")) {
        row.velocity_bps = null;
      }
    });
    const solana = container.querySelector(
      '[data-velocity-chain="solana"] [data-measure="velocity_bps"]',
    )!;
    expect(solana.querySelector("[data-velocity-value]")!.textContent).toBe(UNKNOWN_TEXT);
    expect(solana.querySelector(".velocity-chart__bar")).toBeNull();
    const none = mount((props) => {
      for (const row of props.kpis) {
        row.velocity_bps = null;
        row.velocity_everyday_bps = null;
        row.headline_velocity_bps = null;
      }
    });
    expect(none.container.querySelector("[data-velocity-chain]")).toBeNull();
    expect(none.container.querySelector("h2")!.textContent).toBe(UNKNOWN_TEXT);
  });

  it("doesn't divide by zero at a zero scale", () => {
    const { summary } = getDataset();
    const zero = summary.kpis.map((row) => ({
      ...row,
      velocity_bps: 0,
      velocity_everyday_bps: 0,
      headline_velocity_bps: 0,
    }));
    const chart = velocityChart(zero, []);
    expect(chart.max).toBe(0);
    expect(chart.groups.flatMap((g) => g.bars).every((bar) => bar.widthBps === 0)).toBe(true);
  });

  it("keeps the velocity table under the toggle, with wallets, not people, in its caption", () => {
    const { container } = mount();
    const table = container.querySelector(".data-toggle table")!;
    expect(table.querySelector("caption")!.textContent).toContain("Wallets, not people.");
    const base = within(table as HTMLElement)
      .getByRole("cell", { name: /Base/ })
      .closest("tr")!;
    expect(base.textContent).toContain("42.85%");
    expect(base.textContent).toContain("10.78%");
    expect(base.textContent).toContain("$20M");
    expect(base.textContent).toContain("$200M");
    // Wallets show only in the table, so nothing in view counts them.
    const shown = container.cloneNode(true) as HTMLElement;
    shown.querySelectorAll("details, .sr-only, .tip__panel").forEach((node) => node.remove());
    expect(shown.textContent).not.toMatch(/wallets/i);
  });
});
