import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { JourneyView } from "@/components/views/journey";
import { loadDataset } from "@/lib/dataset/load";
import { UNKNOWN_TEXT } from "@/lib/format";
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
    expect(placed.className).toContain("border-[var(--color-maroon)]");
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
