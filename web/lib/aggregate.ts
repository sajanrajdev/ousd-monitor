import { DAY_ZERO } from "./definitions.ts";
import type { AsOfRange } from "./format.ts";
import type { ActivityRow, ChainName, JourneyRow, KpiRow } from "./dataset/rows.ts";

const sumOf = (values: Iterable<string | null>): bigint => {
  let total = 0n;
  for (const value of values) total += BigInt(value ?? 0);
  return total;
};

// The marts' integer floor: numerator * 10000 // denominator. Null when nothing can divide.
export function floorBps(numerator: bigint, denominator: bigint): number | null {
  return denominator > 0n ? Number((numerator * 10_000n) / denominator) : null;
}

// A day's floor, the same formula as the velocity columns: amount_7d * 10000 // (7 * supply).
function velocityBps(volume7d: bigint, supply: bigint): number | null {
  return floorBps(volume7d, 7n * supply);
}

export function dayRange(days: string[]): AsOfRange | null {
  if (days.length === 0) return null;
  const sorted = [...days].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

export type AllChainKpis = {
  chains: ChainName[];
  asOf: AsOfRange;
  total_supply: string;
  placed_supply: string;
  circulating_supply: string;
  headline_7d: string;
  clean_7d: string;
  clean_everyday_7d: string;
  placed_share_bps: number | null;
  velocity_bps: number | null;
  velocity_everyday_bps: number | null;
  headline_velocity_bps: number | null;
};

// Each chain's newest day, the verdict's basis, so the verdict and a KPI below it can't disagree.
// A 7-day velocity is null if any chain's is, because that chain's window is short. There's no
// wallet total: the same address on three EVM chains would count three times.
export function allChainKpis(kpis: KpiRow[]): AllChainKpis | null {
  const asOf = dayRange(kpis.map((row) => row.day));
  if (!asOf) return null;
  const sum = (field: "total_supply" | "placed_supply" | "circulating_supply") =>
    sumOf(kpis.map((row) => row[field]));
  const sum7d = (field: "headline_7d" | "clean_7d" | "clean_everyday_7d") =>
    sumOf(kpis.map((row) => row[field]));
  const unlessAnyNull = (
    field: "velocity_bps" | "velocity_everyday_bps" | "headline_velocity_bps",
    value: () => number | null,
  ) => (kpis.some((row) => row[field] === null) ? null : value());
  const total = sum("total_supply");
  const placed = sum("placed_supply");
  const circulating = sum("circulating_supply");
  return {
    chains: kpis.map((row) => row.chain),
    asOf,
    total_supply: total.toString(),
    placed_supply: placed.toString(),
    circulating_supply: circulating.toString(),
    headline_7d: sum7d("headline_7d").toString(),
    clean_7d: sum7d("clean_7d").toString(),
    clean_everyday_7d: sum7d("clean_everyday_7d").toString(),
    placed_share_bps: floorBps(placed, total),
    velocity_bps: unlessAnyNull("velocity_bps", () => velocityBps(sum7d("clean_7d"), circulating)),
    velocity_everyday_bps: unlessAnyNull("velocity_everyday_bps", () =>
      velocityBps(sum7d("clean_everyday_7d"), circulating),
    ),
    headline_velocity_bps: unlessAnyNull("headline_velocity_bps", () =>
      velocityBps(sum7d("headline_7d"), total),
    ),
  };
}

// Each chain's newest row, in the order the rows come.
export function newestByChain<Row extends { chain: ChainName; day: string }>(rows: Row[]): Row[] {
  const newest = new Map<ChainName, Row>();
  for (const row of rows) {
    const held = newest.get(row.chain);
    if (!held || row.day > held.day) newest.set(row.chain, row);
  }
  return [...newest.values()];
}

// What total_supply is made of. The loader checks these add up, to the base unit.
export const JOURNEY_PARTS = [
  "issuer_inventory",
  "placed_supply",
  "venue_dex",
  "venue_lending",
  "venue_exchange",
  "free_floating",
] as const;

// Sits inside placed_supply, so it is summed across chains but isn't a part of the total.
const JOURNEY_AMOUNTS = ["total_supply", "placed_exchange_linked", ...JOURNEY_PARTS] as const;

export type JourneyAmounts = Record<(typeof JOURNEY_AMOUNTS)[number], string>;

export type AllChainJourney = JourneyAmounts & { chains: ChainName[]; asOf: AsOfRange };

export function allChainJourney(rows: JourneyRow[]): AllChainJourney | null {
  const newest = newestByChain(rows);
  const asOf = dayRange(newest.map((row) => row.day));
  if (!asOf) return null;
  const amounts = Object.fromEntries(
    JOURNEY_AMOUNTS.map((part) => [part, sumOf(newest.map((row) => row[part])).toString()]),
  ) as JourneyAmounts;
  return { ...amounts, chains: newest.map((row) => row.chain), asOf };
}

// Sums the named fields of the named chains, only for days every one of them has with a value, so a series never dips
// where one chain's history starts late or ends early. `chains` is passed rather than read from the
// rows, so a chain with no rows at all gives an empty series and not a false one.
export function allChainSeries<
  Row extends { chain: ChainName; day: string },
  Field extends keyof Row & string,
>(rows: Row[], chains: ChainName[], fields: readonly Field[]) {
  const byDay = new Map<string, Row[]>();
  for (const row of rows) {
    if (chains.includes(row.chain)) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
  }
  const series: ({ day: string } & Record<Field, string>)[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const dayRows = byDay.get(day)!;
    const complete =
      chains.every((chain) => dayRows.some((row) => row.chain === chain)) &&
      dayRows.every((row) => fields.every((field) => row[field] !== null));
    if (!complete) continue;
    const amounts = Object.fromEntries(
      fields.map((field) => [field, sumOf(dayRows.map((row) => row[field] as string)).toString()]),
    ) as Record<Field, string>;
    series.push({ day, ...amounts });
  }
  return series;
}

export const WATERFALL_PARTS = [
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
] as const;

export type WaterfallPart = (typeof WATERFALL_PARTS)[number];

const FLOW_FIELDS = ["headline_value", ...WATERFALL_PARTS] as const;

type FlowAmounts = Record<(typeof FLOW_FIELDS)[number], string>;

function sumFlows(rows: Pick<ActivityRow, keyof FlowAmounts>[]): FlowAmounts {
  return Object.fromEntries(
    FLOW_FIELDS.map((field) => [field, sumOf(rows.map((row) => row[field])).toString()]),
  ) as FlowAmounts;
}

export type ChainFlows = FlowAmounts & { chain: ChainName; from: string; to: string };

// Per chain, Day 0 through that chain's newest day. A chain whose history starts later says so.
export function chainFlows(rows: ActivityRow[]): ChainFlows[] {
  const chains = [...new Set(rows.map((row) => row.chain))];
  return chains.map((chain) => {
    const own = rows.filter((row) => row.chain === chain && row.day >= DAY_ZERO);
    const days = own.map((row) => row.day).sort();
    return { ...sumFlows(own), chain, from: days[0], to: days[days.length - 1] };
  });
}

export type AllChainFlows = FlowAmounts & { chains: ChainName[]; asOf: AsOfRange };

export function allChainFlows(rows: ActivityRow[]): AllChainFlows | null {
  const perChain = chainFlows(rows);
  const asOf = dayRange(perChain.map((row) => row.to));
  if (!asOf) return null;
  return { ...sumFlows(perChain), chains: perChain.map((row) => row.chain), asOf };
}
