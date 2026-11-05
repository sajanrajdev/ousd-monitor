import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { JourneyView } from "@/components/views/journey";
import { loadDataset } from "@/lib/dataset/load";
import { exchangeRows } from "@/lib/exchange-rows";
import { UNKNOWN_TEXT } from "@/lib/format";
import {
  EXCHANGE_FLOOR_LINK,
  EXCHANGE_FLOOR_NOTE,
  exchangeCoverageNote,
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

describe("journey view", () => {
  it("renders three cards, each with takeaway, source, as-of time and definition link", () => {
    const { container } = render(view().ui);
    const cards = [...container.querySelectorAll(".chart-card")];
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.querySelector("h2, h3")!.textContent!.length).toBeGreaterThan(10);
      expect(card.textContent).toContain("Source:");
      expect(card.querySelector("time")).toBeTruthy();
      expect(card.querySelector('a[href^="/methodology/#"]')).toBeTruthy();
    }
    expect(container.textContent).toMatch(/of supply on the four chains/);
  });

  it("shows exact amounts in the table, circulating from activity, and top-10 share", () => {
    const { container } = render(view().ui);
    const first = container.querySelectorAll("table")[0];
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

  it("marks exchange venues as a floor and shows the exchange-linked band inside placed", () => {
    const { container } = render(view().ui);
    const first = container.querySelectorAll("table")[0];
    expect(first.textContent).toContain("Exchange venues, at least");
    expect(first.textContent).toContain("Of placed, exchange-linked");
    const band = container.querySelector(
      '[data-part="placed_supply"] [data-testid="exchange-linked-band"]',
    );
    expect(band).not.toBeNull();
    expect((band as HTMLElement).style.background).toContain("--meaning-idle");
    expect((band as HTMLElement).style.background).not.toContain("--meaning-circulating");
    expect(band!.parentElement!.querySelector('[data-testid="part-label"]')!.className).toContain(
      "z-10",
    );
    expect(container.querySelector('[data-testid="exchange-linked"]')!.textContent).toContain(
      "of supply",
    );
    const coverage = [...container.querySelectorAll('[data-testid="exchange-coverage"]')];
    expect(coverage.map((note) => note.getAttribute("data-chain"))).toEqual(["solana", "tempo"]);
  });

  it("shows each exchange beside its source, from the dataset", () => {
    const { container } = render(view().ui);
    const rows = [...container.querySelectorAll("[data-exchange-row]")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "Sample Exchange, 2 wallets, at least $610,000,000. Source: each wallet's label.",
      "Sample Listing, no wallet labeled. Source: its OUSD listing.",
    ]);
    const links = rows.map((row) => row.querySelector("a")!);
    expect(links[0].getAttribute("href")).toBe("/methodology/#named-labels");
    expect(links[1].getAttribute("href")).toBe("https://example.com/sample-listing/ousd");
    expect(links[1].getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("gives the floor and the coverage line their own note kinds", () => {
    const { container } = render(view().ui);
    expect(container.querySelector('[data-note="exchange-floor"]')!.textContent).toBe(
      `${EXCHANGE_FLOOR_NOTE} ${EXCHANGE_FLOOR_LINK}.`,
    );
    expect(
      container.querySelector('[data-note="exchange-coverage"][data-chain="tempo"]')!.textContent,
    ).toBe(exchangeCoverageNote("tempo"));
  });

  it("shows each chain's own day when chains differ", () => {
    const { container } = render(view().ui);
    const base = within(container.querySelectorAll("table")[0]).getByText("Base").closest("tr")!;
    expect(base.textContent).toContain("2 Nov 2026");
    expect(container.textContent).toContain("2 Nov 2026 to 3 Nov 2026 UTC");
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
    const solana = within(container.querySelectorAll("table")[0])
      .getByText("Solana")
      .closest("tr")!;
    expect(solana.textContent).toContain(UNKNOWN_TEXT);
    expect(container.textContent).toContain("this chain has no supply");
  });

  it("notes an unlabeled issuer and that unlabeled venues can count as placed", () => {
    const { container } = render(view().ui);
    const notes = screen.getAllByTestId("issuer-unlabeled");
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain("Solana");
    expect(container.textContent).toContain("can count as placed");
    expect(container.querySelector('a[href="/methodology/#venue-supply"]')).toBeTruthy();
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
    const tempo = within(container.querySelectorAll("table")[0]).getByText("Tempo").closest("tr")!;
    expect(tempo.textContent).not.toContain("$320,000,000");
    expect(tempo.textContent).toContain(UNKNOWN_TEXT);
  });

  it("moves the label of a tiny segment into a list", () => {
    const { container } = render(view().ui);
    const lists = container.querySelectorAll('[data-testid="small-segments"]');
    expect(lists.length).toBeGreaterThan(0);
    expect(container.querySelector('[data-part="venue_dex"]')!.textContent).not.toContain(
      "DEX venues",
    );
  });

  it("renders the unknown text and no chart for an empty series", () => {
    const { ui } = view("", (dir) =>
      editJson(dir, "journey.json", (payload) => {
        payload.data = payload.data.filter(
          (r: { day: string }) => r.day === "2026-11-03" || r.day === "2026-11-02",
        );
      }),
    );
    const { container } = render(ui);
    const cards = container.querySelectorAll(".chart-card");
    expect(cards[1].querySelector("h2")!.textContent).toBe(UNKNOWN_TEXT);
    expect(cards[1].querySelector(".recharts-wrapper")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = render(<main>{view().ui}</main>);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
