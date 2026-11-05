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

const notesOf = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-pinned-notes] > [data-note]")].map((note) => ({
    kind: note.getAttribute("data-note"),
    chain: note.getAttribute("data-chain"),
    pin: note.querySelector(".pin")!.textContent,
    text: note.textContent,
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
    expect(container.querySelector("svg, canvas, .recharts-wrapper")).toBeNull();
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

  it("pins a warning beside its chain, numbered, and moves it with the warning", () => {
    const { container } = mount((props) => {
      props.warnings = [WARNING];
    });
    const ethereum = container.querySelector('[data-velocity-chain="ethereum"]')!;
    expect(ethereum.querySelector(".velocity-chart__name .pin")!.textContent).toBe("1");
    const notes = notesOf(container);
    expect(notes[0]).toMatchObject({ kind: "velocity-warning", chain: "ethereum", pin: "1" });
    expect(notes[0].text).toContain("Ethereum, 3 Nov 2026 UTC");
    expect(notes[0].text).toContain("$6.4M");
    expect(notes[0].text).toContain("$2.8M");
    expect(notes[0].text).toContain("unusually high");
    expect(notes[0].text).toContain("shouldn't be read as a trend");
    expect(notes[1]).toMatchObject({ kind: "velocity-denominators", pin: "2" });
    const moved = mount((props) => {
      props.warnings = [{ ...WARNING, chain: "base" }];
    });
    expect(notesOf(moved.container)[0]).toMatchObject({ chain: "base", pin: "1" });
    expect(moved.container.querySelector('[data-velocity-chain="ethereum"] .pin')).toBeNull();
  });

  it("has no pin and no gap without a warning, and numbers two warnings in chart order", () => {
    const none = mount((props) => {
      props.warnings = [{ ...WARNING, metric: "total_supply" }];
    });
    expect(notesOf(none.container)).toEqual([
      expect.objectContaining({ kind: "velocity-denominators", pin: "1" }),
    ]);
    expect(none.container.querySelector("[data-velocity-chain] .pin")).toBeNull();
    none.unmount();
    const two = mount((props) => {
      props.warnings = [
        { ...WARNING, chain: "solana" },
        { ...WARNING, chain: "tempo" },
      ];
    });
    expect(notesOf(two.container).map(({ chain, pin }) => `${chain}:${pin}`)).toEqual([
      "tempo:1",
      "solana:2",
      "null:3",
    ]);
  });

  it("keeps each warning whole, and the denominators and jumpy notes, in the popover", () => {
    const { container } = mount((props) => {
      props.warnings = [WARNING];
    });
    const panel = container.querySelector(".info-popover__panel")!;
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
    const pin = container.querySelector('[data-pinned-notes] [data-note="velocity-denominators"]')!;
    expect(pin.closest("details, noscript")).toBeNull();
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
    shown.querySelectorAll("details, .sr-only").forEach((node) => node.remove());
    expect(shown.textContent).not.toMatch(/wallets/i);
  });
});
