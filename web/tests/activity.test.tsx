import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityView } from "@/components/views/activity";
import { chainOptions } from "@/lib/chain-scope";
import { getDataset } from "@/lib/dataset";
import { CARD_ANCHORS } from "@/lib/definitions";
import { UNKNOWN_TEXT } from "@/lib/format";

function mount(edit?: (props: Parameters<typeof ActivityView>[0]) => void) {
  vi.stubEnv("OUSD_DATASET_DIR", "fixtures/dataset/complete");
  const { activity, summary, manifest, state } = getDataset();
  const props = {
    options: chainOptions(manifest.coverage.chains_included),
    activity: structuredClone(activity),
    kpis: structuredClone(summary.kpis),
    definitions: manifest.definitions,
    warnings: structuredClone(manifest.warnings),
    state,
  };
  edit?.(props);
  return render(<ActivityView {...props} />);
}

// One filter option's card, as the page shows it.
function panel(container: HTMLElement, id: string, value: string): HTMLElement {
  return container.querySelector(`#${id} > [data-chain-panel="${value}"]`)!;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the real activity view", () => {
  it("gives every card a takeaway, source, as-of time and definition link", () => {
    const { container } = mount();
    const cards = [...container.querySelectorAll(".chart-card")];
    // A waterfall and a weekly card per filter option, and the velocity card.
    expect(cards).toHaveLength(11);
    for (const card of cards) {
      expect(card.querySelector("h2")!.textContent!.length).toBeGreaterThan(10);
      expect(card.querySelector(".chart-card__meta")!.textContent).toContain("As of");
      const panel = card.querySelector(".info-popover__panel")!;
      expect(panel.textContent).toContain("Source:");
      expect(panel.querySelector('a[href^="/methodology/#"]')).not.toBeNull();
    }
  });

  it.each([
    ["everyday-meaning", "Everyday means under"],
    ["hops", "Hops across transactions still count more than once."],
    ["wallets-not-people", "Wallets, not people."],
  ])("keeps the %s caveat visible, with nothing opened", (kind, words) => {
    const { container } = mount();
    const notes = [...container.querySelectorAll(`[data-note="${kind}"]`)];
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note.textContent).toContain(words);
      expect(note.closest("details, noscript, .sr-only")).toBeNull();
    }
  });

  it("shows one waterfall row per step, in the mart's order, hatched when removed", () => {
    const { container } = mount();
    const rows = [
      ...panel(container, CARD_ANCHORS.waterfall, "all").querySelectorAll("[data-step]"),
    ];
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
    const row = panel(container, CARD_ANCHORS.waterfall, "all").querySelector(
      '[data-step="fee_liquidity"]',
    )!;
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
    const fees = panel(container, CARD_ANCHORS.waterfall, "all").querySelector(
      '[data-step="fees"]',
    )!;
    expect(fees.textContent).toContain("Fees");
    expect(fees.textContent).toContain("−$21");
    expect(fees.querySelector<HTMLElement>("[data-bar]")!.style.minWidth).toBe("3px");
  });

  it("falls back to the unknown text when the parts don't add up, under All and that chain", () => {
    let broken = "";
    const { container } = mount((props) => {
      const row = props.activity.find((candidate) => candidate.day >= "2026-09-30")!;
      row.clean_large = "1";
      broken = row.chain;
    });
    for (const value of ["all", broken]) {
      const card = panel(container, CARD_ANCHORS.waterfall, value);
      expect(card.querySelector("h2")!.textContent).toBe(UNKNOWN_TEXT);
      expect(card.querySelector("[data-step]")).toBeNull();
    }
    const other = ["tempo", "ethereum", "base", "solana"].find((chain) => chain !== broken)!;
    expect(
      panel(container, CARD_ANCHORS.waterfall, other).querySelectorAll("[data-step]"),
    ).toHaveLength(12);
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
    // A waterfall and weekly bars in each of the five panels.
    expect(container.querySelectorAll("[data-flow]")).toHaveLength(10);
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
    const card = exact.container.querySelector(
      `#${CARD_ANCHORS.waterfall} > [data-chain-panel="all"]`,
    )!;
    const note = card.querySelector('[data-pinned-notes] [data-note="day-0-scope"]')!;
    expect(note.textContent).toContain("Fact");
    expect(note.textContent).toContain("from Day 0, 30 Sept 2026 UTC");
    expect(note.textContent).toContain("total supply predates it");
    expect(note.closest("details, noscript")).toBeNull();
    // Pinned on the headline row, and whole in the popover.
    expect(card.querySelector('[data-step="headline_value"] .pin')!.textContent).toBe("1");
    expect(
      card.querySelector('.info-popover__panel [data-full-note="day-0-scope"]')!.textContent,
    ).toContain("Supply also includes mints from before it");
    exact.unmount();
    // Mismatched by one base unit, so the figure isn't exact and nothing is claimed.
    const off = mount((props) => {
      props.activity.push({ ...props.activity[0], day: "2026-09-01", minted: "5", burned: "0" });
    });
    expect(off.container.querySelector('[data-note="day-0-scope"]')).toBeNull();
  });

  it("pins the small-ticket note under All and Tempo only, short in view and whole in the popover", () => {
    const { container } = mount();
    for (const value of ["all", "tempo", "ethereum", "base", "solana"]) {
      const card = panel(container, CARD_ANCHORS.waterfall, value);
      const note = card.querySelector('[data-pinned-notes] [data-note="small-ticket"]');
      const full = card.querySelector('.info-popover__panel [data-full-note="small-ticket"]');
      if (value === "all" || value === "tempo") {
        expect(note!.textContent).toContain("26 Oct 2026");
        expect(note!.textContent).toContain("unproven");
        expect(full!.textContent).toContain("2,441 transfers to 237 recipients");
        expect(card.querySelector('[data-step="issuer_flows"] .pin')).not.toBeNull();
      } else {
        expect(note).toBeNull();
        expect(full).toBeNull();
        expect(card.querySelector('[data-step="issuer_flows"] .pin')).toBeNull();
      }
    }
  });

  it("numbers each pin as its note, with no gap when a note drops out", () => {
    const { container } = mount();
    for (const value of ["all", "ethereum"]) {
      const card = panel(container, CARD_ANCHORS.waterfall, value);
      const notes = [...card.querySelectorAll("[data-pinned-notes] > [data-note]")];
      const numbers = notes.map((note) => note.querySelector(".pin")!.textContent);
      expect(numbers).toEqual(notes.map((_, index) => String(index + 1)));
      const hops = notes.findIndex((note) => note.getAttribute("data-note") === "hops");
      expect(card.querySelector('[data-step="clean_large"] .pin')!.textContent).toBe(
        String(hops + 1),
      );
      expect(card.querySelector(".chart-area .pin")!.closest("[aria-hidden]")).not.toBeNull();
    }
  });

  it("sums every chain's waterfall back to its headline, with bars at clean large and everyday", () => {
    const { container } = mount();
    const amount = (card: Element, key: string) =>
      card.querySelector(`[data-step="${key}"] .tabular-nums`)!.textContent;
    for (const value of ["all", "tempo", "ethereum", "base", "solana"]) {
      const card = panel(container, CARD_ANCHORS.waterfall, value);
      expect(card.querySelectorAll("[data-step]")).toHaveLength(12);
      expect(amount(card, "headline_value")).toMatch(/^\$/);
      const table = [...card.querySelectorAll(".data-toggle table")];
      expect(table).toHaveLength(2);
      expect(table[1].querySelectorAll("tbody tr")).toHaveLength(value === "all" ? 4 : 1);
    }
  });

  it("names the chain in each filtered heading, and keeps the essential notes in every panel", () => {
    const { container } = mount();
    for (const [id, kinds] of [
      [CARD_ANCHORS.waterfall, ["hops"]],
      [CARD_ANCHORS.weekly, ["everyday-meaning", "history"]],
    ] as const) {
      for (const value of ["tempo", "ethereum", "base", "solana"]) {
        const card = panel(container, id, value);
        const name = value.charAt(0).toUpperCase() + value.slice(1);
        expect(card.querySelector("h2")!.textContent).toMatch(new RegExp(`^On ${name}, `));
        for (const kind of kinds) {
          const note = card.querySelector(`[data-pinned-notes] [data-note="${kind}"]`);
          expect(note, `${kind} on ${value}`).not.toBeNull();
        }
      }
      expect(panel(container, id, "all").querySelector("h2")!.textContent).not.toMatch(/^On /);
    }
  });

  it("gives every chain's weekly bars the same weeks as All", () => {
    const { container } = mount();
    const dates = (value: string) =>
      [
        ...panel(container, CARD_ANCHORS.weekly, value).querySelectorAll(".data-toggle tbody tr"),
      ].map((row) => row.querySelector("td")!.textContent);
    for (const value of ["tempo", "ethereum", "base", "solana"]) {
      expect(dates(value)).toEqual(dates("all"));
    }
  });

  it("says Weeks end on the date shown in the popover, and pins the history", () => {
    const { container } = mount();
    const card = panel(container, CARD_ANCHORS.weekly, "all");
    expect(
      card.querySelector('.info-popover__panel [data-full-note="history"]')!.textContent,
    ).toMatch(/^Weeks end on the date shown, in UTC\. \d+ days of history/);
    expect(card.querySelector('[data-pinned-notes] [data-note="history"]')!.textContent).toMatch(
      /\d+ days of history: a direction, not a trend\./,
    );
    expect(card.querySelectorAll("[data-chart-pins] .pin")).toHaveLength(2);
  });

  it("never says what transfers were for, in any panel", () => {
    const { container } = mount();
    const text = container.textContent!;
    expect(text).not.toMatch(/trading volume/i);
    expect(text).not.toMatch(/\b(commerce|payments?|spending|purchases?)\b/i);
  });
});
