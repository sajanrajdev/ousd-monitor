import { describe, expect, it } from "vitest";
import {
  allChainFlows,
  allChainJourney,
  allChainKpis,
  allChainSeries,
  chainFlows,
  floorBps,
  newestByChain,
} from "@/lib/aggregate";
import type { ActivityRow, JourneyRow, KpiRow } from "@/lib/dataset/rows";
import { at, copySample } from "./dataset-helpers";
import { loadDataset } from "@/lib/dataset/load";

function kpi(overrides: Partial<KpiRow>): KpiRow {
  return {
    chain: "tempo",
    day: "2026-11-03",
    total_supply: "1000",
    placed_supply: "500",
    placed_share_bps: 5000,
    circulating_supply: "400",
    headline_7d: "700",
    clean_7d: "280",
    clean_everyday_7d: "28",
    velocity_bps: 1000,
    velocity_everyday_bps: 100,
    headline_velocity_bps: 1000,
    active_wallets_7d: 10,
    active_wallets_over_100_7d: 5,
    issuer_labeled: true,
    ...overrides,
  };
}

describe("all-chain KPIs", () => {
  it("names a range when chains are at different days", () => {
    const result = allChainKpis([
      kpi({ chain: "tempo", day: "2026-11-03" }),
      kpi({ chain: "base", day: "2026-11-01" }),
    ]);
    expect(result?.asOf).toEqual({ from: "2026-11-01", to: "2026-11-03" });
  });

  it("velocity equals the integer formula on a worked example", () => {
    // (280 + 37) * 10000 // (7 * (400 + 3)) = 3170000 // 2821 = 1123
    const result = allChainKpis([
      kpi({ clean_7d: "280", circulating_supply: "400" }),
      kpi({ chain: "base", clean_7d: "37", circulating_supply: "3" }),
    ]);
    expect(result?.velocity_bps).toBe(1123);
  });

  it("one chain's null velocity gives a null all-chain velocity", () => {
    const result = allChainKpis([
      kpi({}),
      kpi({ chain: "solana", velocity_bps: null, velocity_everyday_bps: null }),
    ]);
    expect(result?.velocity_bps).toBeNull();
    expect(result?.velocity_everyday_bps).toBeNull();
    expect(result?.headline_velocity_bps).not.toBeNull();
  });

  it("a chain at zero supply still gives an all-chain placed share", () => {
    const result = allChainKpis([
      kpi({ total_supply: "1000", placed_supply: "500" }),
      kpi({ chain: "base", total_supply: "0", placed_supply: "0", placed_share_bps: null }),
    ]);
    expect(result?.placed_share_bps).toBe(5000);
  });

  it("a zero denominator gives null", () => {
    expect(floorBps(5n, 0n)).toBeNull();
    const result = allChainKpis([
      kpi({ total_supply: "0", placed_supply: "0", circulating_supply: "0" }),
    ]);
    expect(result?.placed_share_bps).toBeNull();
    expect(result?.velocity_bps).toBeNull();
    expect(result?.headline_velocity_bps).toBeNull();
  });

  it("stays exact above 2^53", () => {
    const huge = String(2n ** 60n + 1n);
    const result = allChainKpis([kpi({ total_supply: huge }), kpi({ total_supply: "1" })]);
    expect(result?.total_supply).toBe(String(2n ** 60n + 2n));
  });

  it("has no wallet total", () => {
    const result = allChainKpis([kpi({})]);
    expect(Object.keys(result!).filter((key) => key.includes("wallet"))).toEqual([]);
  });

  it("is null with no chains", () => {
    expect(allChainKpis([])).toBeNull();
  });

  it("matches the verdict's own placed share on the sample, at different days", () => {
    const { summary } = loadDataset(at(copySample("complete")));
    const percent = Math.floor(allChainKpis(summary.kpis)!.placed_share_bps! / 100);
    expect(summary.verdict.text).toContain(`${percent}% of supply`);
  });
});

function journeyRow(chain: JourneyRow["chain"], day: string, total: string): JourneyRow {
  return {
    chain,
    day,
    total_supply: total,
    issuer_inventory: "0",
    placed_supply: total,
    venue_dex: "0",
    venue_lending: "0",
    venue_exchange: "0",
    free_floating: "0",
    placed_wallets: 1,
    holders: 1,
    holders_over_1m: 1,
    top10_value: total,
    issuer_labeled: true,
  };
}

describe("time series", () => {
  const rows = [
    journeyRow("tempo", "2026-11-01", "10"),
    journeyRow("tempo", "2026-11-02", "20"),
    journeyRow("tempo", "2026-11-03", "30"),
    journeyRow("base", "2026-11-01", "1"),
    journeyRow("base", "2026-11-02", "2"),
  ];

  it("drops days a chain lacks", () => {
    const series = allChainSeries(rows, ["tempo", "base"], ["total_supply"]);
    expect(series).toEqual([
      { day: "2026-11-01", total_supply: "11" },
      { day: "2026-11-02", total_supply: "22" },
    ]);
  });

  it("is empty when an included chain has no rows at all", () => {
    expect(allChainSeries(rows, ["tempo", "solana"], ["total_supply"])).toEqual([]);
  });

  it("drops a day where a field is null, rather than counting it as zero", () => {
    const held = rows.map((row, index) => (index === 0 ? { ...row, top10_value: null } : row));
    const series = allChainSeries(held, ["tempo", "base"], ["top10_value"]);
    expect(series.map((point) => point.day)).toEqual(["2026-11-02"]);
  });

  it("the all-chain journey uses each chain's newest day", () => {
    const result = allChainJourney(rows);
    expect(result?.total_supply).toBe("32");
    expect(result?.asOf).toEqual({ from: "2026-11-02", to: "2026-11-03" });
    expect(newestByChain(rows).map((row) => row.day)).toEqual(["2026-11-03", "2026-11-02"]);
  });
});

describe("flows", () => {
  const dataset = () => loadDataset(at(copySample("complete")));

  it("run from Day 0 to each chain's newest day", () => {
    const flows = chainFlows(dataset().activity);
    const base = flows.find((row) => row.chain === "base")!;
    expect(base.from).toBe("2026-09-30");
    expect(base.to).toBe("2026-11-02");
  });

  it("show when a chain's history starts later", () => {
    const flows = chainFlows(dataset().activity);
    expect(flows.find((row) => row.chain === "solana")!.from).toBe("2026-10-10");
  });

  it("all-chain parts add back to headline exactly, with the range named", () => {
    const flows = allChainFlows(dataset().activity)!;
    const parts = [
      flows.minted,
      flows.burned,
      flows.fees,
      flows.fee_liquidity,
      flows.issuer_flows,
      flows.same_entity,
      flows.same_tx_netting,
      flows.dex_flow,
      flows.lending_flow,
      flows.clean_large,
      flows.clean_everyday,
    ].reduce((sum, part) => sum + BigInt(part), 0n);
    expect(parts).toBe(BigInt(flows.headline_value));
    expect(flows.asOf).toEqual({ from: "2026-11-02", to: "2026-11-03" });
  });

  it("is null with no rows", () => {
    expect(allChainFlows([] as ActivityRow[])).toBeNull();
  });
});
