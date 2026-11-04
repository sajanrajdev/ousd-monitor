import { floorBps } from "../aggregate.ts";
import type { ActivityRow, ChainName, KpiRow } from "../dataset/rows.ts";
import { CHAIN_NAMES } from "../definitions.ts";
import { formatBps, formatCompact, formatUtcDate, UNKNOWN_TEXT } from "../format.ts";

// The mart's order. The last two are what is left: large transfers are split out, not removed.
export const REMOVAL_FIELDS = [
  ["minted", "Mints"],
  ["burned", "Burns"],
  ["fees", "Fees"],
  ["fee_liquidity", "Fee liquidity"],
  ["issuer_flows", "Issuer flows"],
  ["same_entity", "Same-entity transfers"],
  ["same_tx_netting", "Same-transaction netting"],
  ["dex_flow", "DEX flow"],
  ["lending_flow", "Lending flow"],
] as const;

export const CLEAN_FIELDS = [
  ["clean_large", "Clean large"],
  ["clean_everyday", "Clean everyday"],
] as const;

type AmountField =
  (typeof REMOVAL_FIELDS)[number][0] | (typeof CLEAN_FIELDS)[number][0] | "headline_value";

export type WaterfallStep = {
  key: AmountField;
  label: string;
  kind: "headline" | "removal" | "clean";
  amount: string;
  // Where the bar starts and ends on a 0 to headline scale, in base units, so a bar can be placed
  // without a float. A removal spans what was left after it up to what was left before.
  from: string;
  to: string;
};

export type Waterfall = { steps: WaterfallStep[]; headline: string };

function total(rows: ActivityRow[], field: AmountField): bigint {
  let sum = 0n;
  for (const row of rows) sum += BigInt(row[field]);
  return sum;
}

// Day 0 through each chain's newest day, summed over the rows given. Null when there is no headline
// to measure against, or when the parts don't add back up to it: a number that fails the volume
// check isn't published.
export function waterfall(rows: ActivityRow[]): Waterfall | null {
  const headline = total(rows, "headline_value");
  if (rows.length === 0 || headline <= 0n) return null;
  const steps: WaterfallStep[] = [
    {
      key: "headline_value",
      label: "Headline volume",
      kind: "headline",
      amount: headline.toString(),
      from: "0",
      to: headline.toString(),
    },
  ];
  let left = headline;
  for (const [key, label] of REMOVAL_FIELDS) {
    const amount = total(rows, key);
    steps.push({
      key,
      label,
      kind: "removal",
      amount: amount.toString(),
      from: (left - amount).toString(),
      to: left.toString(),
    });
    left -= amount;
  }
  let filled = 0n;
  for (const [key, label] of CLEAN_FIELDS) {
    const amount = total(rows, key);
    steps.push({
      key,
      label,
      kind: "clean",
      amount: amount.toString(),
      from: filled.toString(),
      to: (filled + amount).toString(),
    });
    filled += amount;
  }
  return left === filled ? { steps, headline: headline.toString() } : null;
}

export function waterfallAmount(waterfall: Waterfall, key: AmountField): string {
  return waterfall.steps.find((step) => step.key === key)!.amount;
}

// Bar geometry in basis points of headline, floored; a part above zero never falls to nothing.
export function barPosition(
  step: WaterfallStep,
  headline: string,
): { left: number; width: number } {
  const whole = BigInt(headline);
  const left = Math.max(floorBps(BigInt(step.from), whole) ?? 0, 0);
  const right = floorBps(BigInt(step.to), whole) ?? 0;
  const width = right - left;
  return { left, width: BigInt(step.amount) !== 0n && width < 1 ? 1 : Math.max(width, 0) };
}

export type PerChainPeriod = {
  chain: ChainName;
  from: string;
  to: string;
  days: number;
  rows: ActivityRow[];
};

const CHAIN_ORDER = Object.keys(CHAIN_NAMES) as ChainName[];

export function perChain(rows: ActivityRow[]): PerChainPeriod[] {
  return CHAIN_ORDER.flatMap((chain) => {
    const mine = rows.filter((row) => row.chain === chain);
    if (mine.length === 0) return [];
    const days = mine.map((row) => row.day).sort();
    return [{ chain, from: days[0], to: days[days.length - 1], days: days.length, rows: mine }];
  });
}

export function historyDays(rows: ActivityRow[]): number {
  return new Set(rows.map((row) => row.day)).size;
}

export function historyLabel(rows: ActivityRow[]): string {
  return `${historyDays(rows)} days of history: a direction, not a trend`;
}

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const dayText = (number: number) => new Date(number * DAY_MS).toISOString().slice(0, 10);

export type Week = { from: string; to: string; everyday: string };

// Seven-day blocks counted from the first day in the data. A block counts only once every chain
// has reached its last day, so a chain that is a day behind never makes a week look smaller. A
// chain that hadn't started yet adds nothing, as it did nothing.
export function weeklyEveryday(rows: ActivityRow[]): Week[] {
  if (rows.length === 0) return [];
  const first = Math.min(...rows.map((row) => dayNumber(row.day)));
  const reached = Math.min(...perChain(rows).map((chain) => dayNumber(chain.to)));
  const sums = new Map<number, bigint>();
  for (const row of rows) {
    const week = Math.floor((dayNumber(row.day) - first) / 7);
    sums.set(week, (sums.get(week) ?? 0n) + BigInt(row.clean_everyday));
  }
  const weeks: Week[] = [];
  for (let week = 0; first + week * 7 + 6 <= reached; week += 1) {
    weeks.push({
      from: dayText(first + week * 7),
      to: dayText(first + week * 7 + 6),
      everyday: (sums.get(week) ?? 0n).toString(),
    });
  }
  return weeks;
}

// Sentences say how much is left and how much was taken out. They never say what transfers were for.
export function waterfallTakeaway(waterfall: Waterfall | null): string {
  if (!waterfall) return UNKNOWN_TEXT;
  const clean =
    BigInt(waterfallAmount(waterfall, "clean_large")) +
    BigInt(waterfallAmount(waterfall, "clean_everyday"));
  const share = formatBps(floorBps(clean, BigInt(waterfall.headline)));
  return `Of ${formatCompact(waterfall.headline)} in headline transfers, ${formatCompact(clean.toString())} (${share}) is left as clean volume after the removals.`;
}

export function weeklyTakeaway(weeks: Week[]): string {
  if (weeks.length === 0) return UNKNOWN_TEXT;
  const latest = weeks[weeks.length - 1];
  const now = formatCompact(latest.everyday);
  if (weeks.length === 1) {
    return `Everyday clean volume was ${now} in the week to ${formatUtcDate(latest.to)}.`;
  }
  const before = weeks[weeks.length - 2];
  return `Everyday clean volume was ${now} in the week to ${formatUtcDate(latest.to)}, against ${formatCompact(before.everyday)} the week before.`;
}

export function velocityTakeaway(kpis: KpiRow[]): string {
  const both = kpis.flatMap((row) =>
    row.velocity_bps === null || row.headline_velocity_bps === null
      ? []
      : [{ row, higher: row.velocity_bps > row.headline_velocity_bps }],
  );
  if (both.length === 0) return UNKNOWN_TEXT;
  const above = both.filter((entry) => entry.higher).map((entry) => entry.row);
  if (above.length === 0) {
    return "Velocity is no higher than headline velocity on any chain with a figure.";
  }
  const names = above.map((row) => CHAIN_NAMES[row.chain]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `On ${list}, velocity is higher than headline velocity because the two divide by different supplies.`;
}
