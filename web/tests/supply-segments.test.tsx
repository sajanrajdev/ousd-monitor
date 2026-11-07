import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SupplyBar } from "@/components/views/journey-charts";
import { JourneyView } from "@/components/views/journey";
import { JOURNEY_PARTS, newestByChain } from "@/lib/aggregate";
import { chainOptions } from "@/lib/chain-scope";
import { loadDataset } from "@/lib/dataset/load";
import type { ChainName, JourneyRow } from "@/lib/dataset/rows";
import { chainExchangeRows, exchangeRows } from "@/lib/exchange-rows";
import { formatExact } from "@/lib/format";
import {
  exchangeExtras,
  legendAmount,
  SEGMENT_CONFIG,
  segmentLabel,
  supplyPanel,
  supplySegments,
  type BarRow,
} from "@/lib/supply-segments";
import { journeyHeading } from "@/lib/takeaways/journey";
import { at } from "./dataset-helpers";
import {
  FIXTURE_EXCHANGES,
  largeExchangeActivity,
  largeExchangeJourney,
} from "./supply-exchange-fixture";

const dataset = loadDataset(at("fixtures/dataset/complete"));
const options = chainOptions(dataset.manifest.coverage.chains_included);
const ethereum = newestByChain(dataset.journey).find((row) => row.chain === "ethereum")!;
const definitions = dataset.manifest.definitions;

function renderView(
  overrides: Partial<Parameters<typeof JourneyView>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <JourneyView
      options={options}
      journey={dataset.journey}
      activity={dataset.activity}
      kpis={dataset.summary.kpis}
      definitions={definitions}
      state={dataset.state}
      exchanges={exchangeRows(dataset.labels)}
      {...overrides}
    />,
  );
}

function renderLarge(overrides: Partial<Parameters<typeof JourneyView>[0]> = {}) {
  const journey = largeExchangeJourney(dataset.journey);
  return {
    journey,
    ...renderView({
      journey,
      activity: largeExchangeActivity(dataset.activity, dataset.journey),
      exchanges: FIXTURE_EXCHANGES,
      ...overrides,
    }),
  };
}

// One card holds every chain: a bar row per filter option, and the first option's legend and tables.
// All's card. Each option has its own, and each holds every option's bar.
const supplyCardEl = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('#where-supply-sits > [data-chain-panel="all"]')!;
const supplyRowEl = (container: HTMLElement, value: string) =>
  supplyCardEl(container).querySelector<HTMLElement>(`[data-supply-row="${value}"]`)!;

describe("the segment config", () => {
  it("reads in the order the parts add up in, with a definition each", () => {
    expect(SEGMENT_CONFIG.map((segment) => segment.key)).toEqual([...JOURNEY_PARTS]);
    for (const segment of SEGMENT_CONFIG) {
      expect(segment.definition).toBeTruthy();
    }
  });

  it("brackets everything except issuer inventory and placed as circulating", () => {
    expect(SEGMENT_CONFIG.filter((segment) => !segment.circulating).map((s) => s.key)).toEqual([
      "issuer_inventory",
      "placed_supply",
    ]);
  });
});

describe("supplySegments", () => {
  it("adds up to total supply, to the base unit, on every row", () => {
    for (const row of dataset.journey) {
      const sum = supplySegments(row).reduce((held, segment) => held + BigInt(segment.amount), 0n);
      expect(sum.toString()).toBe(row.total_supply);
    }
  });

  it("marks exchange_linked as a band inside placed that leaves placed as it was", () => {
    const segments = supplySegments(ethereum);
    const placed = segments.find((segment) => segment.key === "placed_supply")!;
    expect(placed.amount).toBe(ethereum.placed_supply);
    expect(placed.band!.amount).toBe(ethereum.placed_exchange_linked);
    expect(placed.band!.line).toMatch(
      /^Exchange-linked, inside placed \$[\d.]+[KMB]? \d+\.\d{2}%$/,
    );
    expect(placed.band!.line).toBe(
      `Exchange-linked, inside placed ${placed.band!.figures.amount} ${placed.band!.figures.share}`,
    );
    expect(segments.map((segment) => segment.key)).not.toContain("placed_exchange_linked");
    expect(segments.filter((segment) => segment.band)).toHaveLength(1);
  });

  it("draws the band with its own pattern, on placed's colour", () => {
    const band = supplySegments(ethereum).find((segment) => segment.band)!.band!;
    const others = SEGMENT_CONFIG.map((segment) => segment.style.image).filter(Boolean);
    const pattern = band.background.split(", var(")[0];
    expect(others).not.toContain(pattern);
    expect(band.background).toContain("var(--meaning-idle)");
  });

  it("gives no coverage or entities without extras", () => {
    for (const segment of supplySegments(ethereum)) {
      expect(segment.coverage).toBeUndefined();
      expect(segment.entities).toBeUndefined();
      expect(segmentLabel(segment)).not.toContain("at least");
    }
    const row: BarRow = { key: "ethereum", journey: ethereum };
    const { container } = render(<SupplyBar row={row} segments={supplySegments(ethereum)} />);
    expect(container.textContent).not.toContain("at least");
  });

  it("makes the exchange segment a floor, with the dataset's rows as its entities", () => {
    const rows = exchangeRows(dataset.labels);
    const exchange = supplySegments(ethereum, exchangeExtras(FIXTURE_EXCHANGES.slice(0, 0))).find(
      (segment) => segment.key === "venue_exchange",
    )!;
    expect(exchange.coverage).toBe("floor");
    expect(segmentLabel(exchange)).toBe("Exchange venues, at least");
    const panel = supplyPanel(options[0], {
      journey: dataset.journey,
      activity: dataset.activity,
      kpis: dataset.summary.kpis,
      definitions,
      exchanges: rows,
    });
    const all = panel.segments.find((segment) => segment.key === "venue_exchange")!;
    expect(all.entities).toEqual(rows);
    expect(all.coverage).toBe("floor");
  });

  it("gives a single chain's panel the floor and only that chain's own rows, not All's", () => {
    const chain = options[2].value as ChainName;
    const own = chainExchangeRows(dataset.labels, chain);
    const panel = supplyPanel(options[2], {
      journey: dataset.journey,
      activity: dataset.activity,
      kpis: dataset.summary.kpis,
      definitions,
      exchanges: exchangeRows(dataset.labels),
      chainExchanges: { [chain]: own },
    });
    const exchange = panel.segments.find((segment) => segment.key === "venue_exchange")!;
    expect(exchange.coverage).toBe("floor");
    expect(exchange.entities).toEqual(own);
    expect(panel.exchanges.rows).toEqual(own);
    // A chain given no rows lists none, rather than falling back to All's.
    const bare = supplyPanel(options[2], {
      journey: dataset.journey,
      activity: dataset.activity,
      kpis: dataset.summary.kpis,
      definitions,
      exchanges: exchangeRows(dataset.labels),
    });
    expect(bare.exchanges.rows).toEqual([]);
    expect(bare.exchanges.caption).toMatch(/^No labeled exchange wallet holds OUSD on /);
  });

  it("refuses rows that add up to more than their segment", () => {
    const large = largeExchangeJourney([ethereum])[0];
    const over = [
      { ...FIXTURE_EXCHANGES[0], amount: (BigInt(large.venue_exchange) + 1n).toString() },
    ];
    expect(() => supplySegments(large, exchangeExtras(over))).toThrow(/more than the segment/);
    const exact = [{ ...FIXTURE_EXCHANGES[0], amount: large.venue_exchange }];
    expect(() => supplySegments(large, exchangeExtras(exact))).not.toThrow();
    expect(() =>
      renderLarge({ exchanges: over.map((row) => ({ ...row, amount: "9".repeat(30) })) }),
    ).toThrow(/more than the segment/);
  });

  it("throws on an amount the row doesn't have, rather than reading it as zero", () => {
    const config = [...SEGMENT_CONFIG, { ...SEGMENT_CONFIG[0], key: "venue_missing" }];
    expect(() => supplySegments(ethereum, {}, config)).toThrow();
  });
});

describe("a large exchange segment and per-exchange rows", () => {
  it("takes its share of the bar with a direct label, and has its legend row", () => {
    const { container } = renderLarge();
    const part = supplyRowEl(container, "ethereum").querySelector<HTMLElement>(
      '[data-part="venue_exchange"]',
    )!;
    expect(part.style.flexBasis).toBe("40%");
    expect(part.querySelector('[data-testid="part-label"]')!.textContent).toContain(
      "Exchange venues, at least 40.00%",
    );
    // The legend is the first option's, over every chain, and its share is that bar's.
    const all = supplyRowEl(container, "all").querySelector<HTMLElement>(
      '[data-part="venue_exchange"]',
    )!;
    const legend = supplyCardEl(container).querySelector('[data-segment="venue_exchange"]')!;
    expect(`${legend.querySelector("[data-segment-share]")!.textContent}`).toBe(
      `${(Number(all.style.flexBasis.replace("%", "")) || 0).toFixed(2)}%`,
    );
  });

  it('shows the total as a floor, with "at least" in words as well as the mark', () => {
    const { container } = renderLarge();
    const legend = supplyCardEl(container).querySelector('[data-segment="venue_exchange"]')!;
    expect(legend.querySelector('[data-coverage="floor"]')!.textContent).toBe("≥");
    expect(legend.querySelector("[data-segment-label]")!.textContent).toBe(
      "Exchange venues, at least",
    );
    // Whole dollars, rounded down, from the first bar's own amount.
    const all = supplyRowEl(container, "all").querySelector<HTMLElement>(
      '[data-part="venue_exchange"]',
    )!;
    expect(legend.querySelector("[data-segment-amount]")!.textContent).toBe(
      `≥${legendAmount({ amount: all.dataset.amount!, coverage: "floor" })}`,
    );
  });

  it("rounds a floor down, so a compact figure can't claim more than the rows", () => {
    const segment = { amount: "346579239723", coverage: "floor" as const };
    expect(legendAmount(segment)).toBe("$346,579");
    expect(legendAmount({ amount: segment.amount })).toBe("$346.6K");
  });

  it("lists each exchange under the data toggle, with its source link", () => {
    const { container } = renderLarge();
    const rows = [...container.querySelectorAll("[data-exchange-row]")];
    expect(rows.map((row) => row.querySelector("[data-exchange-name]")!.textContent)).toEqual([
      "Exchange A",
      "Exchange B",
      "Exchange C",
    ]);
    for (const row of rows) {
      expect(row.closest(".data-toggle")).not.toBeNull();
      expect(row.closest("#where-supply-sits")).not.toBeNull();
      expect(row.querySelector("a[data-exchange-source]")!.getAttribute("href")).toMatch(
        /^https:\/\/example\.com\/Exchange-[ABC]$/,
      );
    }
  });

  it("still adds up to total supply, to the base unit, in what's drawn", () => {
    const { container } = renderLarge();
    for (const { value } of options) {
      const bar = supplyRowEl(container, value).querySelector<HTMLElement>("[data-supply-bar]")!;
      const parts = [...bar.querySelectorAll<HTMLElement>("[data-part]")];
      const sum = parts.reduce((held, part) => held + BigInt(part.dataset.amount!), 0n);
      expect(sum.toString()).toBe(bar.dataset.total);
    }
  });

  it("recomputes the heading and circulating, with no edit", () => {
    const { container, journey } = renderLarge();
    const panel = supplyCardEl(container);
    const eth = journey.filter((row: JourneyRow) => row.chain === "ethereum");
    // The card's heading is over every chain, and moves with the edited rows.
    const heading = journeyHeading(newestByChain(journey), definitions);
    expect(heading).not.toBe(journeyHeading(newestByChain(dataset.journey), definitions));
    expect(panel.querySelector("h2")!.textContent).toBe(heading);
    const before = newestByChain(dataset.activity).find((row) => row.chain === "ethereum")!;
    const moved = BigInt(newestByChain(eth)[0].venue_exchange) - BigInt(ethereum.venue_exchange);
    const after = (BigInt(before.circulating_supply!) + moved).toString();
    expect(within(panel).getAllByText(formatExact(after)).length).toBeGreaterThan(0);
  });

  it("takes a segment added only to the config into the bar, legend and table", () => {
    const journey = dataset.journey.map((row) => ({
      ...row,
      venue_custody: "1000000",
      free_floating:
        BigInt(row.free_floating) >= 1000000n
          ? (BigInt(row.free_floating) - 1000000n).toString()
          : row.free_floating,
    })) as JourneyRow[];
    const config = [
      ...SEGMENT_CONFIG,
      {
        key: "venue_custody",
        label: "Custody venues",
        style: { background: "var(--meaning-active)", color: "var(--color-off-white)" },
        definition: "venue-supply" as const,
        circulating: true,
      },
    ];
    const { container } = renderView({ journey, segmentConfig: config });
    for (const { value } of options) {
      expect(
        supplyRowEl(container, value).querySelector('[data-part="venue_custody"]'),
      ).not.toBeNull();
    }
    const panel = supplyCardEl(container);
    expect(panel.querySelector('[data-segment="venue_custody"]')!.textContent).toContain(
      "Custody venues",
    );
    const cells = [...panel.querySelectorAll('td[data-label="Custody venues"]')];
    expect(cells).toHaveLength(options.length - 1);
    for (const cell of cells) expect(cell.textContent).toBe("$1");
  });
});
