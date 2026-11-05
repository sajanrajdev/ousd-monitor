import { render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainRolesView } from "@/components/views/chain-roles";
import { getDataset } from "@/lib/dataset";
import { UNKNOWN_TEXT } from "@/lib/format";
import { NO_SWAPS_NOTE } from "@/lib/takeaways/caveats";

function mount(edit?: (props: Parameters<typeof ChainRolesView>[0]) => void) {
  vi.stubEnv("OUSD_DATASET_DIR", "fixtures/dataset/complete");
  const { chain_roles, summary, manifest, state } = getDataset();
  const props = {
    chain_roles: structuredClone(chain_roles),
    kpis: summary.kpis,
    definitions: manifest.definitions,
    warnings: manifest.warnings,
    state,
  };
  edit?.(props);
  const result = render(<ChainRolesView {...props} />);
  // The chain grid's card. The velocity card shares its section and has its own tests. An
  // attribute selector, as jsdom finds an id across the whole document, and a second mount repeats it.
  return {
    ...result,
    container: result.container.querySelector('[id="what-each-chain-does"]')! as HTMLElement,
  };
}

// The roles table, under the card's data toggle.
const rolesTable = (container: HTMLElement) =>
  container.querySelector(".data-toggle table")! as HTMLElement;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the chain roles view", () => {
  it("has a takeaway, source, as-of time and definition link, and no chart", () => {
    const { container } = mount();
    const card = container;
    expect(card.classList.contains("chart-card")).toBe(true);
    expect(card.querySelector("h2")!.textContent).toBe("Ethereum leads on all five measures.");
    expect(card.querySelector(".chart-card__meta")!.textContent).toContain("As of");
    const panel = card.querySelector(".tip__panel")!;
    expect(panel.textContent).toContain("Ethereum leads on all 5 measures");
    expect(panel.textContent).toContain("Source:");
    expect(panel.querySelector('a[href="/methodology/#chain-roles"]')).not.toBeNull();
    expect(card.querySelector(".chart-area svg, canvas")).toBeNull();
  });

  it("shows each leading_for value as its sentence, and nothing for a chain with none", () => {
    const { container } = mount();
    const ethereum = rolesTable(container).querySelector('[data-leads="ethereum"]')!;
    expect([...ethereum.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Holds the most supply",
      "Most minted in 30 days",
      "Most everyday clean volume in 30 days",
      "Largest DEX flow in 30 days",
      "Largest lending flow in 30 days",
    ]);
    expect(rolesTable(container).querySelector('[data-leads="base"]')).toBeNull();
    const base = within(rolesTable(container)).getByRole("cell", { name: /Base/ }).closest("tr")!;
    expect(base.textContent).toContain("None");
  });

  it("puts share of supply beside each share of activity, with exact figures formatted", () => {
    const { container } = mount();
    const base = within(rolesTable(container)).getByRole("cell", { name: /Base/ }).closest("tr")!;
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
    const days = [...rolesTable(container).querySelectorAll("tbody tr")].map((tr) => ({
      chain: tr.querySelector("td")!.textContent,
      day: tr.querySelector('td[data-label="As of"]')!.textContent,
    }));
    expect(days.find((d) => d.chain === "Base")!.day).toContain("2 Nov 2026");
    expect(days.find((d) => d.chain === "Ethereum")!.day).toContain("3 Nov 2026");
    expect(container.querySelector(".tip__panel")!.textContent).toContain(
      "Chains end on different days",
    );
  });

  it("shows a null share as the unknown text, not zero", () => {
    const { container } = mount((props) => {
      props.chain_roles[0].supply_share_bps = null;
      props.chain_roles[0].clean_everyday_share_bps = null;
      props.chain_roles[0].dex_flow_share_bps = null;
    });
    const cells = within(rolesTable(container)).getByRole("cell", { name: /Base/ }).closest("tr")!;
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
    expect(rolesTable(container).querySelector('[data-leads="base"]')!.textContent).toBe(
      "Largest DEX flow in 30 days",
    );
    expect(rolesTable(container).querySelector('[data-leads="solana"]')!.textContent).toBe(
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
    // The definition link is the card's tooltip's, so the note keeps only its caveat.
    expect(note.querySelector("a")).toBeNull();
    expect(
      container.querySelector('.chart-card__head .tip__panel a[href="/methodology/#chain-roles"]'),
    ).not.toBeNull();
    const rest = container.cloneNode(true) as HTMLElement;
    rest.querySelector('[data-note="no-swaps"]')!.remove();
    expect(rest.textContent).not.toMatch(/trading|settlement/i);
  });

  it("uses the table's stacked form: every cell carries its label for phone width", () => {
    const { container } = mount();
    const table = rolesTable(container);
    const labels = [...table.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(table.classList.contains("hairline-table")).toBe(true);
    for (const tr of table.querySelectorAll("tbody tr")) {
      expect([...tr.querySelectorAll("td")].map((td) => td.getAttribute("data-label"))).toEqual(
        labels,
      );
    }
  });

  describe("the grid", () => {
    const grid = (container: HTMLElement) => container.querySelector("[data-chain-grid]")!;
    const cell = (container: HTMLElement, measure: string, chain: string) =>
      grid(container).querySelector(
        `[data-grid-measure="${measure}"] [data-grid-chain="${chain}"]`,
      )!;

    it("is a real table in view, with measures as rows and chains as columns", () => {
      const { container } = mount();
      const table = grid(container);
      expect(table.tagName).toBe("TABLE");
      expect(table.closest("[aria-hidden], details")).toBeNull();
      expect(
        [...table.querySelectorAll("tbody tr")].map((tr) => tr.getAttribute("data-grid-measure")),
      ).toEqual(
        expect.arrayContaining(["supply", "issuance", "everyday", "dex_flow", "lending_flow"]),
      );
      expect(
        [...table.querySelectorAll("thead th[data-grid-chain]")].map((th) =>
          th.getAttribute("data-grid-chain"),
        ),
      ).toEqual(["tempo", "ethereum", "base", "solana"]);
    });

    it("marks each leading_for value on its row, in words for assistive tech, and both chains on a tie", () => {
      const { container } = mount();
      for (const measure of ["supply", "issuance", "everyday", "dex_flow", "lending_flow"]) {
        const leads = [
          ...grid(container).querySelectorAll(`[data-grid-measure="${measure}"] td[data-leads]`),
        ];
        expect(leads.map((td) => td.getAttribute("data-grid-chain"))).toEqual(["ethereum"]);
        expect(leads[0].querySelector(".sr-only")!.textContent).toMatch(/leads: /);
      }
      const tie = mount((props) => {
        for (const row of props.chain_roles) {
          row.leading_for = row.chain === "base" || row.chain === "solana" ? ["dex_flow"] : [];
        }
      });
      expect(
        [
          ...grid(tie.container).querySelectorAll('[data-grid-measure="dex_flow"] td[data-leads]'),
        ].map((td) => td.getAttribute("data-grid-chain")),
      ).toEqual(["base", "solana"]);
    });

    it("prints only what the dataset gives: amounts for minted and lending, shares where they exist", () => {
      const { container } = mount();
      const text = (measure: string) =>
        cell(container, measure, "base").querySelector("[data-grid-value]")!.textContent;
      expect(text("supply")).toBe("1.52%");
      expect(text("issuance")).toBe("$189M");
      expect(text("everyday")).toBe("$58M (20.86%)");
      expect(text("dex_flow")).toBe("$58M (5.69%)");
      expect(text("lending_flow")).not.toMatch(/%/);
      // Bars are geometry, with no figure of their own.
      for (const bar of grid(container).querySelectorAll(".chain-grid__bar")) {
        expect(bar.textContent).toBe("");
        expect(bar.getAttribute("aria-hidden")).toBe("true");
      }
    });

    it("scales each row's bars to its largest amount, the lead's", () => {
      const { container } = mount();
      for (const row of grid(container).querySelectorAll(
        "tbody tr[data-grid-measure]:not([data-grid-measure='as-of'])",
      )) {
        const widths = [...row.querySelectorAll(".chain-grid__bar")].map((bar) =>
          Number(bar.getAttribute("data-width")),
        );
        const lead = row.querySelector("td[data-leads] .chain-grid__bar");
        if (lead) expect(Number(lead.getAttribute("data-width"))).toBe(Math.max(...widths));
        expect(widths.every((width) => width >= 0 && width <= 10_000)).toBe(true);
      }
    });

    it("shows an as-of row only when the chains' days differ", () => {
      const { container } = mount();
      expect(grid(container).querySelector('[data-grid-measure="as-of"]')).not.toBeNull();
      const same = mount((props) => {
        for (const row of props.chain_roles) row.as_of_day = "2026-11-03";
      });
      expect(grid(same.container).querySelector('[data-grid-measure="as-of"]')).toBeNull();
    });

    it("gives the no-swaps note a badge with its words in the tooltip, and no pin in the grid", () => {
      const { container } = mount();
      expect(grid(container).querySelector(".pin")).toBeNull();
      const note = container.querySelector('[data-pinned-notes] [data-note="no-swaps"]')!;
      expect(note.closest("details, noscript")).toBeNull();
      expect(note.querySelector(".tip__badge")!.textContent).toBe("1");
      expect(note.querySelector(".tip__panel [data-note-text]")!.textContent).toBe(NO_SWAPS_NOTE);
    });

    it("never calls a chain's role settlement", () => {
      const { container } = mount();
      expect(grid(container).textContent).not.toMatch(/settlement|trading/i);
    });
    it("draws nothing for a negative flow, and says what the mark means in words", () => {
      const { container } = mount((props) => {
        props.chain_roles[0].dex_flow_30d = "-5000000";
      });
      const negative = [
        ...container.querySelectorAll('[data-grid-measure="dex_flow"] .chain-grid__bar'),
      ].find((bar) => bar.getAttribute("data-width") === "0");
      expect(negative).toBeTruthy();
      expect(container.querySelector("[data-chain-grid] caption")!.textContent).toContain(
        "The marked chain leads.",
      );
    });
  });
});
