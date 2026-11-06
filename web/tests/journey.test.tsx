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
  EXCHANGE_FLOOR_PIN,
  exchangeCoverageNote,
  exchangeCoveragePin,
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

// The supply card is one card with every chain in it, a bar row per filter option. Its legend,
// figures, notes and tables are the first option's, which covers every chain.
const card = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("#where-supply-sits")!;
const row = (container: HTMLElement, value: string) =>
  card(container).querySelector<HTMLElement>(`[data-supply-row="${value}"]`)!;
const series = (container: HTMLElement, value: string) =>
  container.querySelector<HTMLElement>(`#placed-vs-circulating > [data-chain-panel="${value}"]`)!;
const noteKeys = (panel: HTMLElement) =>
  [...panel.querySelectorAll(".footnotes__list > [data-note]")].map(
    (note) => `${note.getAttribute("data-note")}:${note.getAttribute("data-chain") ?? ""}`,
  );
// A note is a footnote marker where it applies, and its words, then the note in full, are in the
// card's footnotes.
const footnote = (panel: Element, selector: string) =>
  panel.querySelector(`.footnotes__list > ${selector}`)!;
const markerOf = (panel: Element, note: Element) =>
  panel.querySelector(`a[data-fn-ref][href="#${note.id}"]`);
const noteWords = (note: Element) => note.querySelector("[data-note-text]")!.textContent;
const noteTip = (note: Element) => note.querySelector("[data-note-full]")?.textContent ?? null;

describe("journey view", () => {
  it("renders one supply card with a bar per filter option, and a step line for each", () => {
    const { container } = render(view().ui);
    const supply = card(container);
    expect(supply.matches(".chart-card")).toBe(true);
    expect(supply.querySelector("[data-chain-panel]")).toBeNull();
    expect(
      [...supply.querySelectorAll("[data-supply-row]")].map((r) =>
        r.getAttribute("data-supply-row"),
      ),
    ).toEqual(VALUES);
    const panels = [...container.querySelectorAll("#placed-vs-circulating > [data-chain-panel]")];
    expect(panels.map((panel) => panel.getAttribute("data-chain-panel"))).toEqual(VALUES);
    for (const each of [supply, ...panels.map((panel) => panel.querySelector(".chart-card")!)]) {
      expect(each.querySelector("h2")!.textContent!.length).toBeGreaterThan(10);
      expect(
        each.querySelector(".chart-card__head > .tip--info > .tip__panel")!.textContent,
      ).toContain("Source:");
      expect(each.querySelector(".chart-card__meta time")).toBeTruthy();
      expect(each.querySelector('a[href^="/methodology/#"]')).toBeTruthy();
    }
    expect(container.querySelectorAll(".chart-card")).toHaveLength(1 + VALUES.length);
  });

  it("draws one bar per option, of that option's own chains, named in its row", () => {
    const { container } = render(view().ui);
    for (const value of VALUES) {
      const bars = row(container, value).querySelectorAll("[data-supply-bar]");
      expect(bars).toHaveLength(1);
      expect(bars[0].getAttribute("data-supply-bar")).toBe(value);
    }
    const tempo = row(container, "tempo");
    expect(tempo.querySelector("[data-supply-bar]")!.getAttribute("data-total")).toBe(
      "800000000000000",
    );
    expect(tempo.querySelector(".supply-row__name")!.textContent).toBe("Tempo");
    expect(tempo.querySelector("[data-row-total]")!.textContent).toBe("$800M");
    expect(row(container, "all").querySelector(".supply-row__name")!.textContent).toBe(
      "All chains",
    );
    // The card's heading is the first option's, about every chain.
    expect(card(container).querySelector("h2")!.textContent).not.toMatch(/^On /);
  });

  it("marks where circulating starts on the first bar only", () => {
    const { container } = render(view().ui);
    expect(row(container, "all").querySelector(".supply-bar__bracket")).not.toBeNull();
    for (const value of VALUES.slice(1)) {
      expect(row(container, value).querySelector(".supply-bar__bracket")).toBeNull();
    }
  });

  it("shows exact amounts in the table, circulating from activity, and top-10 share", () => {
    const { container } = render(view().ui);
    const first = card(container).querySelectorAll("table")[0];
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

  it("holds every chain's rows in the one card's tables", () => {
    const { container } = render(view().ui);
    const tables = card(container).querySelectorAll("table");
    expect(tables[0].querySelectorAll("tbody tr")).toHaveLength(4);
    expect(tables[1].querySelectorAll("tbody tr")).toHaveLength(4);
    expect(container.querySelectorAll("#where-supply-sits .data-toggle")).toHaveLength(1);
  });

  it("marks exchange venues as a floor and shows the exchange-linked band inside placed", () => {
    const { container } = render(view().ui);
    const panel = card(container);
    const first = panel.querySelectorAll("table")[0];
    expect(first.textContent).toContain("Exchange venues, at least");
    expect(first.textContent).toContain("Of placed, exchange-linked");
    const band = row(container, "all").querySelector(
      '[data-part="placed_supply"] [data-testid="exchange-linked-band"]',
    );
    expect(band).not.toBeNull();
    expect((band as HTMLElement).style.background).toContain("--meaning-idle");
    expect((band as HTMLElement).style.background).not.toContain("--meaning-circulating");
    expect(band!.parentElement!.querySelector('[data-testid="part-label"]')!.className).toContain(
      "supply-bar__label",
    );
    // Set like every other legend row: its label, then its figure and share in the value columns.
    const line = panel.querySelector("[data-exchange-linked]")!;
    expect(line.querySelector(".chart-legend__label")!.textContent).toBe(
      "Exchange-linked, inside placed",
    );
    expect(line.querySelector(".chart-legend__values")!.textContent).toMatch(
      /^\$[\d.]+[KMB]? \d+\.\d{2}%$/,
    );
  });

  it("carries data-exchange-linked once, in the legend, and draws a band only where there is one", () => {
    const { container } = render(view().ui);
    const lines = [...container.querySelectorAll("[data-exchange-linked]")];
    expect(lines.map((line) => line.getAttribute("data-exchange-linked"))).toEqual(["all"]);
    expect(lines[0].closest("[data-supply-legend]")).not.toBeNull();
    expect(
      row(container, "tempo").querySelector('[data-testid="exchange-linked-band"]'),
    ).toBeNull();
    expect(
      row(container, "ethereum").querySelector('[data-testid="exchange-linked-band"]'),
    ).not.toBeNull();
  });

  it("shows each exchange beside its source, once, under the card's data toggle", () => {
    const { container } = render(view().ui);
    const rows = [...container.querySelectorAll("[data-exchange-row]")];
    expect(rows.map((r) => r.textContent)).toEqual([
      "Sample Exchange, 2 wallets, at least $610,000,000. Source: each wallet's label.",
      "Sample Listing, no wallet labeled. Source: its OUSD listing.",
    ]);
    for (const r of rows) {
      expect(r.closest(".data-toggle")).not.toBeNull();
      expect(r.closest("[data-labels-table]")).not.toBeNull();
      expect(r.closest("#where-supply-sits")).not.toBeNull();
    }
    const links = rows.map((r) => r.querySelector("a")!);
    expect(links[0].getAttribute("href")).toBe("/methodology/#named-labels");
    expect(links[1].getAttribute("href")).toBe("https://example.com/sample-listing/ousd");
    expect(links[1].getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("marks the floor and coverage notes, short and then in full in each footnote", () => {
    const { container } = render(view().ui);
    const panel = card(container);
    const floor = footnote(panel, '[data-note="exchange-floor"]');
    expect(floor.closest("details.footnotes")).not.toBeNull();
    expect(noteWords(floor)).toBe(EXCHANGE_FLOOR_PIN);
    expect(noteTip(floor)).toBe(`${EXCHANGE_FLOOR_NOTE} ${EXCHANGE_FLOOR_LINK}.`);
    // Its link is in the footnote, and its marker sits outside any disclosure.
    expect(floor.querySelector("a")!.textContent).toBe(EXCHANGE_FLOOR_LINK);
    expect(markerOf(panel, floor)!.closest("details, .tip__panel")).toBeNull();
    const tempo = footnote(panel, '[data-note="exchange-coverage"][data-chain="tempo"]');
    expect(markerOf(panel, tempo)!.closest("details, .tip__panel")).toBeNull();
    expect(noteWords(tempo)).toBe(exchangeCoveragePin("tempo"));
    expect(noteTip(tempo)).toBe(exchangeCoverageNote("tempo"));
  });

  it("lists every chain's coverage and issuer notes once, on the one card", () => {
    const { container } = render(view().ui);
    // The card's own note first, on its title, then each segment's, down the legend.
    expect(noteKeys(card(container))).toEqual([
      "wallets-not-people:",
      "issuer-unlabeled:solana",
      "placed:",
      "exchange-floor:",
      "exchange-coverage:solana",
      "exchange-coverage:tempo",
    ]);
    // Each series panel's card has its marker on its title, and one footnote list.
    for (const value of VALUES) {
      const panel = series(container, value);
      expect(panel.querySelectorAll(".chart-card__head [data-fn-refs]")).toHaveLength(1);
      expect(panel.querySelectorAll("details.footnotes")).toHaveLength(1);
    }
  });

  it("marks a note about the whole card on its title, and each segment's note on its legend row", () => {
    const { container } = render(view().ui);
    const panel = card(container);
    const head = panel.querySelector(".chart-card__head")!;
    expect(head.querySelector('a[data-fn-ref][data-note="wallets-not-people"]')!.textContent).toBe(
      "1",
    );
    const issuer = panel.querySelector(
      '[data-segment="issuer_inventory"] a[data-fn-ref][data-note="issuer-unlabeled"]',
    )!;
    expect(issuer.textContent).toBe("2");
    expect(noteWords(panel.querySelector(issuer.getAttribute("href")!.replace(/:/g, "\\:"))!)).toBe(
      issuerUnlabeledNote("solana"),
    );
    expect(
      panel.querySelector('[data-segment="placed_supply"] a[data-fn-ref][data-note="placed"]'),
    ).not.toBeNull();
    const floor = panel.querySelector('[data-segment="venue_exchange"]')!;
    expect(
      [...floor.querySelectorAll("a[data-fn-ref]")].map((note) => note.getAttribute("data-note")),
    ).toEqual(["exchange-floor", "exchange-coverage", "exchange-coverage"]);
    // No tooltip on a marker, and no badge left.
    expect(panel.querySelector(".tip__badge, .note-badges")).toBeNull();
    expect(floor.querySelector("[data-tip]")).toBeNull();
  });

  it("numbers its markers in reading order, its one set, with no pin in its legend or bars", () => {
    const { container } = render(view().ui);
    const panel = card(container);
    const markers = [...panel.querySelectorAll("a[data-fn-ref]")];
    const numbers = markers.map((marker) => marker.textContent);
    expect(numbers).toEqual(numbers.map((_, index) => String(index + 1)));
    expect(markers.map((marker) => marker.getAttribute("href"))).toEqual(
      [...panel.querySelectorAll(".footnotes__list > li")].map((item) => `#${item.id}`),
    );
    expect(panel.querySelector(".pin")).toBeNull();
    expect(panel.querySelector("[data-supply-bar] a[data-fn-ref]")).toBeNull();
  });

  it("marks the short placed note, with the note in full in its footnote and the card's tooltip", () => {
    const { container } = render(view().ui);
    const panel = card(container);
    const note = footnote(panel, '[data-note="placed"]');
    expect(noteWords(note)).toBe(PLACED_PIN);
    expect(noteTip(note)).toBe(PLACED_NOTE);
    expect(
      panel.querySelector(".chart-card__head > .tip--info > .tip__panel")!.textContent,
    ).toContain(PLACED_NOTE);
    expect(panel.querySelector('a[href="/methodology/#venue-supply"]')).toBeTruthy();
  });

  it("lists every segment once, and draws no part at zero", () => {
    const { container } = render(view().ui);
    expect(card(container).querySelectorAll("[data-supply-legend]")).toHaveLength(1);
    expect(card(container).querySelectorAll("[data-supply-legend] [data-segment]")).toHaveLength(6);
    expect(row(container, "tempo").querySelector('[data-part="venue_exchange"]')).toBeNull();
    expect(row(container, "all").querySelector('[data-part="venue_exchange"]')).not.toBeNull();
  });

  it("puts the legend and figures outside the hidden graphic, and the bars in it", () => {
    const { container } = render(view().ui);
    const panel = card(container);
    expect(panel.querySelector("[data-supply-legend]")!.closest("[aria-hidden]")).toBeNull();
    expect(panel.querySelector("[data-stat]")!.closest("[aria-hidden]")).toBeNull();
    for (const bar of panel.querySelectorAll("[data-supply-bar]")) {
      expect(bar.closest("[aria-hidden]")).not.toBeNull();
    }
  });

  it("shows circulating and clean volume beside the bars, and no wallet count in view", () => {
    const { container } = render(view().ui);
    const stats = [...card(container).querySelectorAll("[data-stat]")].map((stat) =>
      stat.getAttribute("data-stat"),
    );
    expect(stats).toEqual(["circulating", "clean-7d"]);
    const wallets = footnote(card(container), '[data-note="wallets-not-people"]');
    expect(noteWords(wallets)).toBe("Wallets, not people.");
    expect(noteTip(wallets)).toContain("never added across chains");
  });

  it("shows no wallet total, in any figure", () => {
    const { container } = render(view().ui);
    const panel = card(container);
    // What's in view beside the bars, leaving out the notes' tooltips.
    const shown = panel.querySelector(".chart-card__beside")!.cloneNode(true) as HTMLElement;
    for (const tip of shown.querySelectorAll(".tip__panel")) tip.remove();
    const beside = shown.textContent;
    expect(beside).not.toMatch(/wallets/i);
    expect(beside).not.toContain("1,200");
    const rows = [...panel.querySelectorAll("[data-supply-row]")].map((r) => r.textContent).join();
    expect(rows).not.toMatch(/wallets/i);
  });

  it("shows each chain's own day when chains differ", () => {
    const { container } = render(view().ui);
    const table = card(container).querySelectorAll("table")[0];
    const base = within(table).getByText("Base").closest("tr")!;
    expect(base.textContent).toContain("2 Nov 2026");
    expect(card(container).querySelector(".chart-card__meta time")!.textContent).toBe(
      "2 Nov 2026 to 3 Nov 2026 UTC",
    );
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
    const solana = row(container, "solana");
    expect(solana.querySelector("[data-supply-bar]")).toBeNull();
    expect(solana.querySelector('[data-chart="supply-bar"]')!.textContent).toContain(
      "this chain has no supply",
    );
    const tableRow = within(card(container).querySelectorAll("table")[0])
      .getByText("Solana")
      .closest("tr")!;
    expect(tableRow.textContent).toContain(UNKNOWN_TEXT);
    expect(row(container, "all").querySelector("[data-supply-bar]")).not.toBeNull();
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
    const tempo = within(card(container).querySelectorAll("table")[0])
      .getByText("Tempo")
      .closest("tr")!;
    expect(tempo.textContent).not.toContain("$320,000,000");
    expect(tempo.textContent).toContain(UNKNOWN_TEXT);
    expect(
      card(container).querySelector('[data-stat="circulating"] [data-stat-value]')!.textContent,
    ).toBe(UNKNOWN_TEXT);
  });

  it("labels a segment on the bar only at or above the threshold", () => {
    const { container } = render(view().ui);
    const ethereum = row(container, "ethereum");
    expect(ethereum.querySelector('[data-part="venue_dex"]')!.textContent).toBe("");
    expect(ethereum.querySelector('[data-part="placed_supply"]')!.textContent).toContain("75.00%");
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

  it("marks the start of the series, with the note in full in its footnote and the card's tooltip", () => {
    const { dataset, ui } = view();
    const { container } = render(ui);
    const definitions = dataset.manifest.definitions;
    for (const value of VALUES) {
      const panel = series(container, value);
      const note = footnote(panel, '[data-note="series-start"]');
      expect(markerOf(panel, note)!.closest("details, .tip__panel")).toBeNull();
      expect(noteWords(note)).toBe(seriesStartPin(definitions));
      expect(noteTip(note)).toBe(seriesStartNote(definitions));
      expect(
        panel.querySelector(".chart-card__head > .tip--info > .tip__panel")!.textContent,
      ).toContain(seriesStartNote(definitions));
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
    // All and one chain, as every chain's panel is the same markup, and axe is slow on the whole
    // view. acceptance.mjs runs axe on every panel in a browser.
    const { dataset, ui } = view();
    const options = chainOptions(dataset.manifest.coverage.chains_included).slice(0, 2);
    const { container } = render(<main>{cloneElement(ui, { options })}</main>);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
