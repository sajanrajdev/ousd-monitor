import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityView } from "@/components/views/activity";
import { waterfallPanel } from "@/lib/activity-panels";
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
    state,
  };
  edit?.(props);
  return render(<ActivityView {...props} />);
}

// One filter option's card, as the page shows it.
function panel(container: HTMLElement, id: string, value: string): HTMLElement {
  return container.querySelector(`#${id} > [data-chain-panel="${value}"]`)!;
}

// A note's footnote in a card's list, and the marker that points at it.
function footnote(card: Element, kind: string): Element | null {
  return card.querySelector(`.footnotes__list > [data-note="${kind}"]`);
}

function markerOf(card: Element, kind: string): Element | null {
  return card.querySelector(`a[data-fn-ref][data-note="${kind}"]`);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the real activity view", () => {
  it("gives every card a takeaway, source, as-of time and definition link", () => {
    const { container } = mount();
    const cards = [...container.querySelectorAll(".chart-card")];
    // A waterfall and a weekly card per filter option.
    expect(cards).toHaveLength(10);
    for (const card of cards) {
      expect(card.querySelector("h2")!.textContent!.length).toBeGreaterThan(10);
      expect(card.querySelector(".chart-card__meta")!.textContent).toContain("As of");
      const panel = card.querySelector(".chart-card__head > .tip--info > .tip__panel")!;
      expect(panel.textContent).toContain("Source:");
      expect(panel.querySelector('a[href^="/methodology/#"]')).not.toBeNull();
    }
  });

  it.each([
    ["everyday-meaning", "Everyday means under"],
    ["hops", "Hops across transactions still count more than once."],
  ])("marks the %s caveat in view, with its words in the card's footnotes", (kind, words) => {
    const { container } = mount();
    const notes = [...container.querySelectorAll(`.footnotes__list > [data-note="${kind}"]`)];
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note.textContent).toContain(words);
      const marker = container.querySelector(`a[data-fn-ref][href="#${note.id}"]`)!;
      expect(marker.closest("details, noscript, .sr-only")).toBeNull();
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

  it("has no wallet figure and never says trading volume", () => {
    const { container } = mount();
    const text = container.textContent!;
    expect(text).not.toMatch(/trading volume/i);
    expect(text).not.toMatch(/wallets/i);
    expect(screen.queryAllByText(/DEX flow/).length).toBeGreaterThan(0);
  });

  it("renders the small-ticket note with its date and 'unproven'", () => {
    const { container } = mount();
    const note = footnote(container, "small-ticket")!;
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

  it("says the Day 0 scope when the rows add up to supply, and leaves it out when not", () => {
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
    const note = footnote(card, "day-0-scope")!;
    // No chip: the page reads as inferred throughout, and a fact needs no marker of its own.
    expect(note.querySelector(".status-chip")).toBeNull();
    const words = note.querySelector("[data-note-text]")!.textContent;
    expect(words).toContain("from Day 0, 30 Sept 2026 UTC");
    expect(words).toContain("supply predates it");
    // Its marker is the first, on the headline row, and the note is whole in the card's tooltip.
    const marker = markerOf(card, "day-0-scope")!;
    expect(marker.textContent).toBe("1");
    expect(marker.closest('[data-step="headline_value"]')).not.toBeNull();
    expect(card.querySelector(".chart-area .pin")).toBeNull();
    expect(card.querySelector('.tip__panel [data-full-note="day-0-scope"]')!.textContent).toContain(
      "Supply also includes mints from before it",
    );
    exact.unmount();
    // Mismatched by one base unit, so the figure isn't exact and nothing is claimed.
    const off = mount((props) => {
      props.activity.push({ ...props.activity[0], day: "2026-09-01", minted: "5", burned: "0" });
    });
    expect(off.container.querySelector('[data-note="day-0-scope"]')).toBeNull();
  });

  it("marks the small-ticket note under All and Tempo only, short in its footnote and whole in the card's tooltip", () => {
    const { container } = mount();
    for (const value of ["all", "tempo", "ethereum", "base", "solana"]) {
      const card = panel(container, CARD_ANCHORS.waterfall, value);
      const note = footnote(card, "small-ticket");
      const full = card.querySelector('.tip__panel [data-full-note="small-ticket"]');
      if (value === "all" || value === "tempo") {
        const words = note!.querySelector("[data-note-text]")!.textContent;
        expect(words).toContain("26 Oct 2026");
        expect(words).toContain("unproven");
        expect(markerOf(card, "small-ticket")).not.toBeNull();
        expect(full!.textContent).toContain("2,441 transfers to 237 recipients");
      } else {
        expect(note).toBeNull();
        expect(full).toBeNull();
      }
      expect(card.querySelector(".chart-area .pin")).toBeNull();
    }
  });

  it("numbers each marker as its footnote, in reading order with no gap when a note drops out", () => {
    const { container } = mount();
    for (const value of ["all", "ethereum"]) {
      const card = panel(container, CARD_ANCHORS.waterfall, value);
      const markers = [...card.querySelectorAll("a[data-fn-ref]")];
      const numbers = markers.map((marker) => marker.textContent);
      expect(numbers).toEqual(markers.map((_, index) => String(index + 1)));
      const items = [...card.querySelectorAll(".footnotes__list > li")];
      expect(markers.map((marker) => marker.getAttribute("href"))).toEqual(
        items.map((item) => `#${item.id}`),
      );
      expect(markers.some((marker) => marker.getAttribute("data-note") === "hops")).toBe(true);
      expect(card.querySelector(".chart-area .pin, .tip__badge")).toBeNull();
      // Each marker sits on the waterfall row it qualifies, so the chart is read, not hidden.
      expect(card.querySelector('[data-step="clean_large"] [data-note="hops"]')).not.toBeNull();
      expect(card.querySelector(".chart-area")!.hasAttribute("aria-hidden")).toBe(false);
    }
    const all = panel(container, CARD_ANCHORS.waterfall, "all");
    expect(
      all.querySelector('[data-step="issuer_flows"] [data-note="small-ticket"]'),
    ).not.toBeNull();
    // The weekly card's notes are about the whole card, so their markers are on its title.
    const weekly = panel(container, CARD_ANCHORS.weekly, "all");
    expect(weekly.querySelectorAll(".chart-card__head a[data-fn-ref]")).toHaveLength(2);
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
          expect(footnote(card, kind), `${kind} on ${value}`).not.toBeNull();
          expect(markerOf(card, kind), `${kind} marker on ${value}`).not.toBeNull();
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

  it("says Weeks end on the date shown in the tooltip, and marks the history", () => {
    const { container } = mount();
    const card = panel(container, CARD_ANCHORS.weekly, "all");
    expect(card.querySelector('.tip__panel [data-full-note="history"]')!.textContent).toMatch(
      /^Weeks end on the date shown, in UTC\. \d+ days of history/,
    );
    expect(footnote(card, "history")!.querySelector("[data-note-text]")!.textContent).toMatch(
      /\d+ days of history: a direction, not a trend\./,
    );
    expect(card.querySelectorAll("a[data-fn-ref]")).toHaveLength(2);
    expect(card.querySelector(".chart-area .pin")).toBeNull();
  });

  it("never says what transfers were for, in any panel", () => {
    const { container } = mount();
    const text = container.textContent!;
    expect(text).not.toMatch(/trading volume/i);
    expect(text).not.toMatch(/\b(commerce|payments?|spending|purchases?)\b/i);
  });

  it("keeps notes but no pins when a chain's waterfall is unknown", () => {
    vi.stubEnv("OUSD_DATASET_DIR", "fixtures/dataset/complete");
    const { activity, summary, manifest } = getDataset();
    const rows = structuredClone(activity);
    // Base mints before Day 0 that add up to its supply, and nothing moves from Day 0.
    for (const row of rows.filter((r) => r.chain === "base")) {
      for (const key of [
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
      ] as const) {
        row[key] = "0";
      }
    }
    rows.push({
      ...rows.find((r) => r.chain === "base")!,
      day: "2026-09-01",
      minted: "5000000",
      headline_value: "5000000",
    });
    const kpis = structuredClone(summary.kpis).map((row) =>
      row.chain === "base" ? { ...row, total_supply: "5000000" } : row,
    );
    const option = chainOptions(manifest.coverage.chains_included).find((o) => o.value === "base")!;
    const panel = waterfallPanel(option, {
      activity: rows,
      kpis,
      definitions: manifest.definitions,
    });
    expect(panel.waterfall).toBeNull();
    expect(panel.notes.map((note) => note.kind)).toEqual(["day-0-scope"]);
    expect(panel.notes[0].step).toBeUndefined();
    expect(panel.notes[0].text).toContain("of Base's $5 supply predates it");
  });
});
