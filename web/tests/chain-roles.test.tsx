import { render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainRolesView } from "@/components/views/chain-roles";
import { getDataset } from "@/lib/dataset";
import { UNKNOWN_TEXT } from "@/lib/format";

function mount(edit?: (props: Parameters<typeof ChainRolesView>[0]) => void) {
  vi.stubEnv("OUSD_DATASET_DIR", "fixtures/dataset/complete");
  const { chain_roles, state } = getDataset();
  const props = { chain_roles: structuredClone(chain_roles), state };
  edit?.(props);
  return render(<ChainRolesView {...props} />);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the chain roles view", () => {
  it("has a takeaway, source, as-of time and definition link, and no chart", () => {
    const { container } = mount();
    const cards = container.querySelectorAll(".chart-card");
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.querySelector("h2")!.textContent).toBe("Ethereum leads on all five measures.");
    expect(card.querySelector(".chart-card__meta")!.textContent).toContain("As of");
    const panel = card.querySelector(".info-popover__panel")!;
    expect(panel.textContent).toContain("Ethereum leads on all 5 measures");
    expect(panel.textContent).toContain("Source:");
    expect(panel.querySelector('a[href="/methodology/#chain-roles"]')).not.toBeNull();
    expect(card.querySelector("svg, canvas")).toBeNull();
  });

  it("shows each leading_for value as its sentence, and nothing for a chain with none", () => {
    const { container } = mount();
    const ethereum = container.querySelector('[data-leads="ethereum"]')!;
    expect([...ethereum.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Holds the most supply",
      "Most minted in 30 days",
      "Most everyday clean volume in 30 days",
      "Largest DEX flow in 30 days",
      "Largest lending flow in 30 days",
    ]);
    expect(container.querySelector('[data-leads="base"]')).toBeNull();
    const base = within(container as HTMLElement)
      .getByRole("cell", { name: /Base/ })
      .closest("tr")!;
    expect(base.textContent).toContain("None");
  });

  it("puts share of supply beside each share of activity, with exact figures formatted", () => {
    const { container } = mount();
    const base = within(container as HTMLElement)
      .getByRole("cell", { name: /Base/ })
      .closest("tr")!;
    const cell = (label: string) => base.querySelector(`td[data-label="${label}"]`)!.textContent;
    expect(cell("Share of supply")).toBe("1.52%");
    expect(cell("Placed share of chain")).toBe("90.00%");
    expect(cell("Clean everyday, 30 days (share)")).toBe("$58M (20.86%)");
    expect(cell("Minted, 30 days")).toBe("$189M");
    expect(cell("DEX flow, 30 days (share)")).toBe("$58M (5.69%)");
    const swatch = base.querySelector<HTMLElement>('[data-swatch="base"]')!;
    expect(swatch).not.toBeNull();
    expect(swatch.getAttribute("style")).toContain("border: 1px solid var(--color-maroon)");
  });

  it("shows each row's own as-of day and says the days differ", () => {
    const { container } = mount();
    const days = [...container.querySelectorAll("tbody tr")].map((tr) => ({
      chain: tr.querySelector("td")!.textContent,
      day: tr.querySelector('td[data-label="As of"]')!.textContent,
    }));
    expect(days.find((d) => d.chain === "Base")!.day).toContain("2 Nov 2026");
    expect(days.find((d) => d.chain === "Ethereum")!.day).toContain("3 Nov 2026");
    expect(container.querySelector(".info-popover__panel")!.textContent).toContain(
      "Chains end on different days",
    );
  });

  it("shows a null share as the unknown text, not zero", () => {
    const { container } = mount((props) => {
      props.chain_roles[0].supply_share_bps = null;
      props.chain_roles[0].clean_everyday_share_bps = null;
      props.chain_roles[0].dex_flow_share_bps = null;
    });
    const cells = within(container as HTMLElement)
      .getByRole("cell", { name: /Base/ })
      .closest("tr")!;
    expect(cells.querySelector('td[data-label="Share of supply"]')!.textContent).toBe(UNKNOWN_TEXT);
    expect(
      cells.querySelector('td[data-label="Clean everyday, 30 days (share)"]')!.textContent,
    ).toBe(`$58M (${UNKNOWN_TEXT})`);
    expect(cells.querySelector('td[data-label="DEX flow, 30 days (share)"]')!.textContent).toBe(
      `$58M (${UNKNOWN_TEXT})`,
    );
  });

  it("names both chains on a tie and keeps their sentences", () => {
    const { container } = mount((props) => {
      for (const row of props.chain_roles) {
        row.leading_for = row.chain === "base" || row.chain === "solana" ? ["dex_flow"] : [];
      }
    });
    expect(container.querySelector("h2")!.textContent).toContain("Base and Solana tie on DEX flow");
    expect(container.querySelector('[data-leads="base"]')!.textContent).toBe(
      "Largest DEX flow in 30 days",
    );
    expect(container.querySelector('[data-leads="solana"]')!.textContent).toBe(
      "Largest DEX flow in 30 days",
    );
  });

  it("renders with no chains, and with a chain leading on nothing", () => {
    const empty = mount((props) => {
      props.chain_roles = [];
    });
    expect(empty.container.querySelector("h2")!.textContent).toBe(UNKNOWN_TEXT);
    empty.unmount();
    const none = mount((props) => {
      for (const row of props.chain_roles) row.leading_for = [];
    });
    expect(none.container.querySelector("h2")!.textContent).toBe(
      "No chain leads on any measure in this data.",
    );
  });

  it("uses 'trading' only in the plain note, never 'settlement'", () => {
    const { container } = mount();
    const note = container.querySelector('[data-note="no-swaps"]')!;
    expect(note.textContent).toContain("We don’t ingest swaps, so this view can’t show trading.");
    expect(note.querySelector('a[href="/methodology/#chain-roles"]')).not.toBeNull();
    const rest = container.cloneNode(true) as HTMLElement;
    rest.querySelector('[data-note="no-swaps"]')!.remove();
    expect(rest.textContent).not.toMatch(/trading|settlement/i);
  });

  it("uses the table's stacked form: every cell carries its label for phone width", () => {
    const { container } = mount();
    const labels = [...container.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(container.querySelector("table.hairline-table")).not.toBeNull();
    for (const tr of container.querySelectorAll("tbody tr")) {
      expect([...tr.querySelectorAll("td")].map((td) => td.getAttribute("data-label"))).toEqual(
        labels,
      );
    }
  });
});
