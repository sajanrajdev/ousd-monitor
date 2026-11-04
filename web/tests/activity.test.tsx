import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityView } from "@/components/views/activity";
import { getDataset } from "@/lib/dataset";
import { UNKNOWN_TEXT } from "@/lib/format";

function mount(edit?: (props: Parameters<typeof ActivityView>[0]) => void) {
  vi.stubEnv("OUSD_DATASET_DIR", "fixtures/dataset/complete");
  const { activity, summary, manifest, state } = getDataset();
  const props = {
    activity: structuredClone(activity),
    kpis: structuredClone(summary.kpis),
    definitions: manifest.definitions,
    warnings: structuredClone(manifest.warnings),
    state,
  };
  edit?.(props);
  return render(<ActivityView {...props} />);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the real activity view", () => {
  it("gives every card a takeaway, source, as-of time and definition link", () => {
    const { container } = mount();
    const cards = [...container.querySelectorAll(".chart-card")];
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.querySelector("h2")!.textContent!.length).toBeGreaterThan(10);
      expect(card.querySelector(".chart-card__meta")!.textContent).toContain("As of");
      const panel = card.querySelector(".info-popover__panel")!;
      expect(panel.textContent).toContain("Source:");
      expect(panel.querySelector('a[href^="/methodology/#"]')).not.toBeNull();
    }
  });

  it("shows one waterfall row per step, in the mart's order, hatched when removed", () => {
    const { container } = mount();
    const rows = [...container.querySelectorAll("[data-step]")];
    expect(rows.map((row) => row.getAttribute("data-step"))).toEqual([
      "headline_value",
      "minted",
      "burned",
      "fees",
      "fee_liquidity",
      "issuer_flows",
      "same_entity",
      "same_tx_netting",
      "dex_flow",
      "lending_flow",
      "clean_large",
      "clean_everyday",
    ]);
    const minted = rows[1].querySelector("[data-bar]") as HTMLElement;
    expect(minted.getAttribute("style")).toContain("repeating-linear-gradient");
    expect(rows[10].textContent).toContain("Clean large");
  });

  it("keeps the label of a part that is zero", () => {
    const { container } = mount((props) => {
      for (const row of props.activity) {
        row.clean_large = (BigInt(row.clean_large) + BigInt(row.fee_liquidity)).toString();
        row.fee_liquidity = "0";
      }
    });
    const row = container.querySelector('[data-step="fee_liquidity"]')!;
    expect(row.textContent).toContain("Fee liquidity");
    expect(row.textContent).toContain("$0");
  });

  it("shows both velocities, both denominators and the explanation where velocity is higher", () => {
    const { container } = mount();
    const table = within(
      container.querySelector('[data-note="velocity-denominators"]')!.closest("section")!,
    );
    const base = table.getByRole("cell", { name: /Base/ }).closest("tr")!;
    expect(base.textContent).toContain("42.85%");
    expect(base.textContent).toContain("10.78%");
    expect(base.textContent).toContain("$20M");
    expect(base.textContent).toContain("$200M");
    const note = container.querySelector('[data-note="velocity-denominators"]')!;
    expect(note.textContent).toContain("velocity can be higher than headline velocity");
    expect(note.textContent).toContain("They aren't two cuts of one number.");
    expect(note.querySelector('a[href="/methodology/#velocity"]')).not.toBeNull();
  });

  it("keeps a $21 fee beside a $2B headline readable", () => {
    const { container } = mount((props) => {
      props.activity = props.activity.slice(0, 1);
      Object.assign(props.activity[0], {
        headline_value: "2000000000000000",
        minted: "0",
        burned: "0",
        fees: "21000000",
        fee_liquidity: "0",
        issuer_flows: "0",
        same_entity: "0",
        same_tx_netting: "0",
        dex_flow: "0",
        lending_flow: "0",
        clean_large: "1999999979000000",
        clean_everyday: "0",
      });
    });
    const fees = container.querySelector('[data-step="fees"]')!;
    expect(fees.textContent).toContain("Fees");
    expect(fees.textContent).toContain("−$21");
    expect(fees.querySelector<HTMLElement>("[data-bar]")!.style.minWidth).toBe("3px");
  });

  it("falls back to the unknown text when the parts don't add up", () => {
    const { container } = mount((props) => {
      props.activity[0].clean_large = "1";
    });
    expect(container.querySelector("h2")!.textContent).toBe(UNKNOWN_TEXT);
  });

  it("shows the unknown text for a chain with no velocity, not 0%", () => {
    const { container } = mount((props) => {
      for (const row of props.kpis.filter((r) => r.chain === "solana")) {
        row.velocity_bps = null;
        row.velocity_everyday_bps = null;
      }
    });
    const solana = within(
      container.querySelector('[data-note="velocity-denominators"]')!.closest("section")!,
    )
      .getByRole("cell", { name: /Solana/ })
      .closest("tr")!;
    expect(solana.textContent).toContain(UNKNOWN_TEXT);
    expect(solana.textContent).not.toMatch(/0\.00%/);
  });

  it("takes the history length from the data", () => {
    const { container } = mount((props) => {
      props.activity = props.activity.filter((row) => row.day <= "2026-10-06");
    });
    expect(container.textContent).toContain("7 days of history: a direction, not a trend");
  });

  it("starts the waterfall and weekly bars at Day 0 even when earlier test rows exist", () => {
    const { container } = mount((props) => {
      props.activity.unshift({
        ...props.activity[0],
        day: "2026-04-24",
        headline_value: "999000000000000",
        clean_everyday: "999000000000000",
      });
    });
    expect(container.textContent).not.toContain("24 Apr 2026");
    expect(container.textContent).toContain("30 Sept 2026");
    expect(container.querySelectorAll("[data-flow]")).toHaveLength(2);
  });

  it("has no all-chain wallet total and never says trading volume", () => {
    const { container } = mount();
    const text = container.textContent!;
    expect(text).not.toMatch(/trading volume/i);
    expect(text).not.toMatch(/all[- ]chains?.{0,20}wallets|total (active )?wallets/i);
    expect(screen.queryAllByText(/DEX flow/).length).toBeGreaterThan(0);
    // One wallet figure per chain, and none is a sum across chains.
    const velocity = container
      .querySelector('[data-note="velocity-denominators"]')!
      .closest("section")!;
    const rows = [...velocity.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(4);
    const walletCells = rows.map((tr) => tr.querySelectorAll("td")[6].textContent);
    const sum = walletCells.reduce((total, cell) => total + Number(cell), 0);
    expect(walletCells).not.toContain(String(sum));
  });

  it("renders the small-ticket note with its date and 'unproven'", () => {
    const { container } = mount();
    const note = container.querySelector('[data-note="small-ticket"]')!;
    expect(note.textContent).toContain("26 Oct 2026");
    expect(note.textContent).toContain("unproven");
    expect(note.textContent).toContain("4.07M");
  });

  it("says Sample on every card on sample data", () => {
    const { container } = mount();
    for (const card of container.querySelectorAll(".chart-card")) {
      expect(card.getAttribute("data-frame")).toBe("Sample");
    }
  });

  it("always says that a small circulating supply makes velocity jumpy", () => {
    const { container } = mount();
    expect(container.querySelector('[data-note="velocity-jumpy"]')!.textContent).toMatch(
      /small circulating supply makes velocity jumpy/,
    );
    expect(container.querySelector('[data-note="velocity-warning"]')).toBeNull();
  });

  it("dates a velocity note from each circulating-supply warning, and ignores other metrics", () => {
    const { container } = mount((props) => {
      props.warnings = [
        {
          chain: "ethereum",
          metric: "circulating_supply",
          day: "2026-11-03",
          previous: "6405808717650",
          current: "2837423707650",
        },
        { chain: "base", metric: "total_supply", day: "2026-11-03", previous: "1", current: "2" },
      ];
    });
    const notes = [...container.querySelectorAll('[data-note="velocity-warning"]')];
    expect(notes).toHaveLength(1);
    expect(notes[0].getAttribute("data-chain")).toBe("ethereum");
    const text = notes[0].textContent!;
    expect(text).toContain("3 Nov 2026 UTC");
    expect(text).toContain("$6.4M");
    expect(text).toContain("$2.8M");
    expect(text).toContain("unusually high");
    expect(text).toContain("shouldn't be read as a trend");
    expect(notes[0].closest("section")!.querySelector("table")).not.toBeNull();
  });

  it("says the Day 0 scope as a Fact when the rows add up to supply, and leaves it out when not", () => {
    const exact = mount((props) => {
      const [first] = props.activity;
      props.activity.push({
        ...first,
        day: "2026-09-01",
        minted: "5000000000000",
        burned: "1000000000000",
      });
      for (const kpi of props.kpis) {
        if (kpi.chain !== first.chain) continue;
        kpi.total_supply = props.activity
          .filter((row) => row.chain === kpi.chain)
          .reduce((sum, row) => sum + BigInt(row.minted) - BigInt(row.burned), 0n)
          .toString();
      }
    });
    const note = exact.container.querySelector('[data-note="day-0-scope"]')!;
    expect(note.textContent).toContain("Fact");
    expect(note.textContent).toContain("from Day 0, 30 Sept 2026 UTC");
    expect(note.textContent).toContain("Supply also includes mints from before it");
    exact.unmount();
    // Mismatched by one base unit, so the figure isn't exact and nothing is claimed.
    const off = mount((props) => {
      props.activity.push({ ...props.activity[0], day: "2026-09-01", minted: "5", burned: "0" });
    });
    expect(off.container.querySelector('[data-note="day-0-scope"]')).toBeNull();
  });
});
