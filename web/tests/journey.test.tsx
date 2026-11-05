import { fireEvent, render, within } from "@testing-library/react";
import axe from "axe-core";
import { cloneElement } from "react";
import { describe, expect, it } from "vitest";
import { ChainFilter } from "@/components/chain-filter";
import { JourneyView } from "@/components/views/journey";
import { chainOptions } from "@/lib/chain-scope";
import { loadDataset } from "@/lib/dataset/load";
import { exchangeRows } from "@/lib/exchange-rows";
import { UNKNOWN_TEXT } from "@/lib/format";
import {
  EXCHANGE_FLOOR_LINK,
  EXCHANGE_FLOOR_NOTE,
  exchangeCoverageNote,
  issuerUnlabeledNote,
  PLACED_NOTE,
  PLACED_PIN,
  seriesStartNote,
  seriesStartPin,
} from "@/lib/takeaways/caveats";
import { at, copySample, editJson } from "./dataset-helpers";

function view(dir = "fixtures/dataset/complete", change?: (dir: string) => void) {
  let location = at(dir);
  if (change) {
    const copy = copySample("complete");
    change(copy);
    location = at(copy);
  }
  const dataset = loadDataset(location);
  return {
    dataset,
    ui: (
      <JourneyView
        options={chainOptions(dataset.manifest.coverage.chains_included)}
        journey={dataset.journey}
        activity={dataset.activity}
        kpis={dataset.summary.kpis}
        definitions={dataset.manifest.definitions}
        state={dataset.state}
        exchanges={exchangeRows(dataset.labels)}
      />
    ),
  };
}

const VALUES = ["all", "tempo", "ethereum", "base", "solana"];

const supply = (container: HTMLElement, value: string) =>
  container.querySelector<HTMLElement>(`#where-supply-sits > [data-chain-panel="${value}"]`)!;
const series = (container: HTMLElement, value: string) =>
  container.querySelector<HTMLElement>(`#placed-vs-circulating > [data-chain-panel="${value}"]`)!;
const noteKeys = (panel: HTMLElement) =>
  [...panel.querySelectorAll("[data-pinned-notes] > [data-note]")].map(
    (note) => `${note.getAttribute("data-note")}:${note.getAttribute("data-chain") ?? ""}`,
  );
const noteWords = (note: Element) => note.querySelector("p")!.textContent;

describe("journey view", () => {
  it("renders a supply card and a step line for every filter option", () => {
    const { container } = render(view().ui);
    for (const box of ["#where-supply-sits", "#placed-vs-circulating"]) {
      const panels = [...container.querySelectorAll(`${box} > [data-chain-panel]`)];
      expect(panels.map((panel) => panel.getAttribute("data-chain-panel"))).toEqual(VALUES);
      for (const panel of panels) {
        const card = panel.querySelector(".chart-card")!;
        expect(card.querySelector("h2")!.textContent!.length).toBeGreaterThan(10);
        expect(card.textContent).toContain("Source:");
        expect(card.querySelector("time")).toBeTruthy();
        expect(card.querySelector('a[href^="/methodology/#"]')).toBeTruthy();
      }
    }
    expect(container.querySelectorAll(".chart-card")).toHaveLength(10);
  });

  it("draws one bar per panel, of that option's own chains", () => {
    const { container } = render(view().ui);
    for (const value of VALUES) {
      const bars = supply(container, value).querySelectorAll("[data-supply-bar]");
      expect(bars).toHaveLength(1);
      expect(bars[0].getAttribute("data-supply-bar")).toBe(value);
    }
    const tempo = supply(container, "tempo");
    expect(tempo.querySelector("[data-supply-bar]")!.getAttribute("data-total")).toBe(
      "800000000000000",
    );
    expect(tempo.querySelector("h2")!.textContent).toMatch(/^On Tempo, /);
  });

  it("shows exact amounts in the table, circulating from activity, and top-10 share", () => {
    const { container } = render(view().ui);
    const first = supply(container, "all").querySelectorAll("table")[0];
    const tempo = within(first).getByText("Tempo").closest("tr")!;
    expect(tempo.textContent).toContain("$800,000,000"); // total
    expect(tempo.textContent).toContain("$320,000,000"); // circulating, from activity
    expect(tempo.textContent).toContain("80.00%"); // top-10 of 800M: 640M
    const placed = container.querySelector<HTMLElement>('[data-part="placed_supply"]')!;
    expect(placed).toBeTruthy();
    expect(placed.style.boxShadow).toBe("");
    // Only ramp steps 3 and 4 (removed, idle) carry the maroon outline; the others are bare.
    expect(placed.style.border).toBe("1px solid var(--color-maroon)");
    const free = container.querySelector<HTMLElement>('[data-part="free_floating"]')!;
    expect(free.style.border).toBe("");
    expect(free.className).not.toContain("maroon");
  });

  it("gives a panel only its own chain's table rows", () => {
    const { container } = render(view().ui);
    expect(
      supply(container, "all").querySelectorAll("table")[0].querySelectorAll("tbody tr"),
    ).toHaveLength(4);
    const base = supply(container, "base").querySelectorAll("table");
    expect(base[0].querySelectorAll("tbody tr")).toHaveLength(1);
    expect(base[0].textContent).toContain("Base");
    expect(base[0].textContent).not.toContain("Tempo");
    expect(base[1].querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("marks exchange venues as a floor and shows the exchange-linked band inside placed", () => {
    const { container } = render(view().ui);
    const panel = supply(container, "all");
    const first = panel.querySelectorAll("table")[0];
    expect(first.textContent).toContain("Exchange venues, at least");
    expect(first.textContent).toContain("Of placed, exchange-linked");
    const band = panel.querySelector(
      '[data-part="placed_supply"] [data-testid="exchange-linked-band"]',
    );
    expect(band).not.toBeNull();
    expect((band as HTMLElement).style.background).toContain("--meaning-idle");
    expect((band as HTMLElement).style.background).not.toContain("--meaning-circulating");
    expect(band!.parentElement!.querySelector('[data-testid="part-label"]')!.className).toContain(
      "z-10",
    );
    expect(panel.querySelector("[data-exchange-linked]")!.textContent).toContain("of supply");
  });

  it("carries data-exchange-linked once for each bar with a band, and keeps the line at zero", () => {
    const { container } = render(view().ui);
    const lines = [...container.querySelectorAll("[data-exchange-linked]")];
    expect(lines.map((line) => line.getAttribute("data-exchange-linked"))).toEqual([
      "all",
      "ethereum",
    ]);
    const tempo = supply(container, "tempo");
    expect(tempo.querySelector("[data-exchange-linked]")).toBeNull();
    expect(tempo.querySelector('[data-testid="exchange-linked-band"]')).toBeNull();
    expect(tempo.querySelector('[data-band="placed_supply"]')!.textContent).toContain("$0");
  });

  it("shows each exchange beside its source, once, under All's data toggle", () => {
    const { container } = render(view().ui);
    const rows = [...container.querySelectorAll("[data-exchange-row]")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "Sample Exchange, 2 wallets, at least $610,000,000. Source: each wallet's label.",
      "Sample Listing, no wallet labeled. Source: its OUSD listing.",
    ]);
    for (const row of rows) {
      expect(row.closest(".data-toggle")).not.toBeNull();
      expect(row.closest("[data-labels-table]")).not.toBeNull();
      expect(row.closest('[data-chain-panel="all"]')).not.toBeNull();
    }
    const links = rows.map((row) => row.querySelector("a")!);
    expect(links[0].getAttribute("href")).toBe("/methodology/#named-labels");
    expect(links[1].getAttribute("href")).toBe("https://example.com/sample-listing/ousd");
    expect(links[1].getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps the floor and coverage notes in view on every panel they apply to, word for word", () => {
    const { container } = render(view().ui);
    for (const value of VALUES) {
      const panel = supply(container, value);
      const floor = panel.querySelector('[data-note="exchange-floor"]')!;
      expect(floor.closest("details")).toBeNull();
      expect(noteWords(floor)).toBe(`${EXCHANGE_FLOOR_NOTE} ${EXCHANGE_FLOOR_LINK}.`);
    }
    const tempo = supply(container, "tempo").querySelector(
      '[data-note="exchange-coverage"][data-chain="tempo"]',
    )!;
    expect(tempo.closest("details")).toBeNull();
    expect(noteWords(tempo)).toBe(exchangeCoverageNote("tempo"));
  });

  it("names only a panel's own chains in its coverage and issuer notes", () => {
    const { container } = render(view().ui);
    const common = ["placed:", "exchange-floor:"];
    const wallets = ["wallets-not-people:"];
    expect(noteKeys(supply(container, "all"))).toEqual([
      "issuer-unlabeled:solana",
      ...common,
      "exchange-coverage:solana",
      "exchange-coverage:tempo",
      ...wallets,
    ]);
    expect(noteKeys(supply(container, "solana"))).toEqual([
      "issuer-unlabeled:solana",
      ...common,
      "exchange-coverage:solana",
      ...wallets,
    ]);
    expect(noteKeys(supply(container, "tempo"))).toEqual([
      ...common,
      "exchange-coverage:tempo",
      ...wallets,
    ]);
    expect(noteKeys(supply(container, "ethereum"))).toEqual([...common, ...wallets]);
    expect(noteKeys(supply(container, "base"))).toEqual([...common, ...wallets]);
  });

  it("pins the issuer note on All and its own chain's legend row, and no other", () => {
    const { container } = render(view().ui);
    const pin = (value: string) =>
      supply(container, value).querySelector('[data-segment="issuer_inventory"] .pin');
    expect(pin("all")!.textContent).toBe("1");
    expect(pin("solana")!.textContent).toBe("1");
    for (const value of ["tempo", "ethereum", "base"]) expect(pin(value)).toBeNull();
    const note = supply(container, "solana").querySelector('[data-note="issuer-unlabeled"]')!;
    expect(noteWords(note)).toBe(issuerUnlabeledNote("solana"));
  });

  it("numbers a legend row's pins as its notes are numbered", () => {
    const { container } = render(view().ui);
    const panel = supply(container, "all");
    const numbered = [...panel.querySelectorAll("[data-pinned-notes] > [data-note]")].map(
      (note) => [note.getAttribute("data-note"), note.querySelector(".pin")!.textContent],
    );
    const pins = (key: string) =>
      [...panel.querySelectorAll(`[data-segment="${key}"] .pin`)].map((pin) => pin.textContent);
    const of = (kind: string) => numbered.filter(([name]) => name === kind).map(([, n]) => n);
    expect(pins("placed_supply")).toEqual(of("placed"));
    expect(pins("venue_exchange")).toEqual([...of("exchange-floor"), ...of("exchange-coverage")]);
    expect(panel.querySelector('[data-part="placed_supply"] .pin')!.textContent).toBe(
      of("placed")[0],
    );
  });

  it("holds the short placed pin in view, with the note in full in the popover", () => {
    const { container } = render(view().ui);
    const panel = supply(container, "all");
    expect(noteWords(panel.querySelector('[data-note="placed"]')!)).toBe(PLACED_PIN);
    expect(panel.querySelector(".info-popover__panel")!.textContent).toContain(PLACED_NOTE);
    expect(panel.querySelector('a[href="/methodology/#venue-supply"]')).toBeTruthy();
  });

  it("lists every segment on every panel, a zero as $0 and not a gap", () => {
    const { container } = render(view().ui);
    for (const value of VALUES) {
      const rows = supply(container, value).querySelectorAll("[data-supply-legend] [data-segment]");
      expect(rows).toHaveLength(6);
    }
    const tempo = supply(container, "tempo");
    expect(
      tempo.querySelector('[data-segment="venue_exchange"] [data-segment-amount]')!.textContent,
    ).toBe("≥$0");
    expect(tempo.querySelector('[data-part="venue_exchange"]')).toBeNull();
  });

  it("puts the legend and figures outside the hidden graphic, and the bar in it", () => {
    const { container } = render(view().ui);
    const panel = supply(container, "all");
    expect(panel.querySelector("[data-supply-legend]")!.closest("[aria-hidden]")).toBeNull();
    expect(panel.querySelector("[data-stat]")!.closest("[aria-hidden]")).toBeNull();
    expect(panel.querySelector("[data-supply-bar]")!.closest("[aria-hidden]")).not.toBeNull();
  });

  it("shows circulating and clean volume beside the bar, and wallets only for one chain", () => {
    const { container } = render(view().ui);
    const stats = (value: string) =>
      [...supply(container, value).querySelectorAll("[data-stat]")].map((stat) =>
        stat.getAttribute("data-stat"),
      );
    expect(stats("all")).toEqual(["circulating", "clean-7d"]);
    for (const value of VALUES.slice(1)) {
      expect(stats(value)).toEqual(["circulating", "clean-7d", "active-wallets"]);
    }
    const wallets = supply(container, "tempo").querySelector('[data-stat="active-wallets"]')!;
    expect(wallets.querySelector("[data-stat-value]")!.textContent).toBe("300");
    expect(wallets.querySelector(".pin")).not.toBeNull();
    expect(supply(container, "all").querySelector("[data-pinned-notes]")!.textContent).toContain(
      "never added across chains",
    );
  });

  it("shows no wallet total under All, in any figure", () => {
    const { container } = render(view().ui);
    const panel = supply(container, "all");
    const beside = panel.querySelector(".chart-card__beside")!.textContent;
    expect(beside).not.toMatch(/wallets/i);
    expect(beside).not.toContain("1,200");
  });

  it("shows each chain's own day when chains differ", () => {
    const { container } = render(view().ui);
    const table = supply(container, "all").querySelectorAll("table")[0];
    const base = within(table).getByText("Base").closest("tr")!;
    expect(base.textContent).toContain("2 Nov 2026");
    expect(container.textContent).toContain("2 Nov 2026 to 3 Nov 2026 UTC");
    expect(supply(container, "base").querySelector("time")!.textContent).toBe("2 Nov 2026 UTC");
  });

  it("does not divide by zero on a chain with no supply", () => {
    const { ui } = view("", (dir) =>
      editJson(dir, "journey.json", (payload) => {
        for (const r of payload.data.filter((x: { chain: string }) => x.chain === "solana")) {
          for (const k of [
            "total_supply",
            "issuer_inventory",
            "placed_supply",
            "venue_dex",
            "venue_lending",
            "venue_exchange",
            "free_floating",
          ])
            r[k] = "0";
          r.top10_value = "0";
        }
      }),
    );
    const { container } = render(ui);
    const panel = supply(container, "solana");
    expect(panel.querySelector("h2")!.textContent).toBe(UNKNOWN_TEXT);
    expect(panel.querySelector("[data-supply-bar]")).toBeNull();
    expect(panel.querySelector('[data-chart="supply-bar"]')!.textContent).toContain(
      "this chain has no supply",
    );
    const row = within(panel.querySelectorAll("table")[0]).getByText("Solana").closest("tr")!;
    expect(row.textContent).toContain(UNKNOWN_TEXT);
    expect(supply(container, "all").querySelector("[data-supply-bar]")).not.toBeNull();
  });

  it("shows circulating only from the journey row's own day", () => {
    const { ui } = view("", (dir) =>
      editJson(dir, "activity.json", (payload) => {
        payload.data = payload.data.filter(
          (r: { chain: string; day: string }) => !(r.chain === "tempo" && r.day === "2026-11-03"),
        );
      }),
    );
    const { container } = render(ui);
    const tempo = within(supply(container, "all").querySelectorAll("table")[0])
      .getByText("Tempo")
      .closest("tr")!;
    expect(tempo.textContent).not.toContain("$320,000,000");
    expect(tempo.textContent).toContain(UNKNOWN_TEXT);
    const stat = (value: string) =>
      supply(container, value).querySelector('[data-stat="circulating"] [data-stat-value]')!
        .textContent;
    expect(stat("tempo")).toBe(UNKNOWN_TEXT);
    expect(stat("all")).toBe(UNKNOWN_TEXT);
  });

  it("labels a segment on the bar only at or above the threshold", () => {
    const { container } = render(view().ui);
    const panel = supply(container, "ethereum");
    expect(panel.querySelector('[data-part="venue_dex"]')!.textContent).toBe("");
    expect(panel.querySelector('[data-part="placed_supply"]')!.textContent).toContain("75.00%");
  });

  it("renders the unknown text and no chart for an empty series", () => {
    const { dataset, ui } = view();
    const definitions = { ...dataset.manifest.definitions, journey_first_day: "2099-01-01" };
    const { container } = render(cloneElement(ui, { definitions }));
    for (const value of VALUES) {
      const panel = series(container, value);
      expect(panel.querySelector("h2")!.textContent).toBe(UNKNOWN_TEXT);
      expect(panel.querySelector(".chart-area")!.textContent).toBe(UNKNOWN_TEXT);
      expect(panel.querySelector(".recharts-responsive-container")).toBeNull();
      expect(panel.querySelector("[data-series-legend]")).toBeNull();
      expect(panel.querySelectorAll("tbody tr")).toHaveLength(0);
    }
  });

  it("is unknown with a single day, which isn't a change", () => {
    const { ui } = view("", (dir) =>
      editJson(dir, "journey.json", (payload) => {
        payload.data = payload.data.filter((r: { day: string }) => r.day >= "2026-11-02");
      }),
    );
    const { container } = render(ui);
    expect(series(container, "all").querySelector("h2")!.textContent).toBe(UNKNOWN_TEXT);
  });

  it("gives each step line its own chain's rows, heading and table caption", () => {
    const { container } = render(view().ui);
    const tempo = series(container, "tempo");
    expect(tempo.querySelector("h2")!.textContent).toMatch(/^On Tempo, placed share: /);
    expect(tempo.querySelector("caption")!.textContent).toBe("Supply over time, Tempo");
    expect(series(container, "all").querySelector("caption")!.textContent).toBe(
      "Supply over time, chains summed",
    );
    expect(series(container, "all").querySelector("h2")!.textContent).toMatch(/^Placed share: /);
    const rows = tempo.querySelector("tbody tr")!;
    expect(rows.textContent).toMatch(/\$/);
  });

  it("pins the start of the series, with the note in full in the popover", () => {
    const { dataset, ui } = view();
    const { container } = render(ui);
    const definitions = dataset.manifest.definitions;
    for (const value of VALUES) {
      const panel = series(container, value);
      const note = panel.querySelector('[data-note="series-start"]')!;
      expect(note.closest("details")).toBeNull();
      expect(noteWords(note)).toBe(seriesStartPin(definitions));
      expect(panel.querySelector(".info-popover__panel")!.textContent).toContain(
        seriesStartNote(definitions),
      );
    }
    expect(seriesStartNote(definitions)).not.toContain("first card");
  });

  it("mounts the step line only in the chosen panel, and follows the filter", () => {
    const { dataset, ui } = view();
    const { container, getByRole } = render(
      <>
        <ChainFilter options={chainOptions(dataset.manifest.coverage.chains_included)} />
        {ui}
      </>,
    );
    const drawn = () =>
      VALUES.filter((value) =>
        series(container, value).querySelector(".recharts-responsive-container"),
      );
    expect(drawn()).toEqual(["all"]);
    fireEvent.click(getByRole("radio", { name: "Base" }));
    expect(drawn()).toEqual(["base"]);
  });

  it("has no axe violations", async () => {
    // All and one chain, as every chain's panel is the same markup, and axe is slow on the ten cards
    // of the whole view. acceptance.mjs runs axe on every panel in a browser.
    const { dataset, ui } = view();
    const options = chainOptions(dataset.manifest.coverage.chains_included).slice(0, 2);
    const { container } = render(<main>{cloneElement(ui, { options })}</main>);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
