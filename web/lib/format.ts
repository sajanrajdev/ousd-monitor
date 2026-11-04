import { formatUtcDate, formatUtcDateTime } from "../components/chart-theme.ts";

export { formatUtcDate, formatUtcDateTime };

export const UNKNOWN_TEXT = "Not enough data yet";

const UNIT = 1_000_000n;
const MINUS = "−";

type Amount = string | bigint | null | undefined;

function inTenths(tenths: bigint, suffix: string): string {
  const fraction = tenths % 10n;
  return `$${tenths / 10n}${fraction === 0n ? "" : `.${fraction}`}${suffix}`;
}

function compactDollars(baseUnits: bigint): string {
  // The same steps as the pipeline's format_dollars, so a figure here and in the verdict's own
  // text can't round apart. Half up, and a unit that rounds to 1000 gives way to the next.
  const dollars = (baseUnits + UNIT / 2n) / UNIT;
  if (dollars < 1_000n) return `$${dollars}`;
  for (const [size, suffix] of [
    [1_000n, "K"],
    [1_000_000n, "M"],
  ] as const) {
    const tenths = (dollars * 10n + size / 2n) / size;
    if (tenths < 10_000n) return inTenths(tenths, suffix);
  }
  return inTenths((dollars * 10n + 500_000_000n) / 1_000_000_000n, "B");
}

function signed(value: bigint, format: (magnitude: bigint) => string): string {
  return value < 0n ? `${MINUS}${format(-value)}` : format(value);
}

// $605.5M. 1 OUSD displays as $1: the site doesn't track price.
export function formatCompact(amount: Amount): string {
  if (amount === null || amount === undefined) return UNKNOWN_TEXT;
  const value = BigInt(amount);
  // An amount that rounds to nothing has no sign to show.
  return compactDollars(value < 0n ? -value : value) === "$0"
    ? "$0"
    : signed(value, compactDollars);
}

function withSeparators(digits: bigint): string {
  return digits.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// $9,007,199,254.740993, with the cents dropped only when they are all zero.
export function formatExact(amount: Amount): string {
  if (amount === null || amount === undefined) return UNKNOWN_TEXT;
  return signed(BigInt(amount), (magnitude) => {
    const fraction = (magnitude % UNIT).toString().padStart(6, "0").replace(/0+$/, "");
    return `$${withSeparators(magnitude / UNIT)}${fraction ? `.${fraction}` : ""}`;
  });
}

// Base units with separators, for a table that compares to the unit.
export function formatBaseUnits(amount: Amount): string {
  if (amount === null || amount === undefined) return UNKNOWN_TEXT;
  return signed(BigInt(amount), withSeparators);
}

// 12.34%. A bps figure is an integer floor, so this never rounds past a threshold.
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return UNKNOWN_TEXT;
  const magnitude = Math.abs(bps);
  const percent = `${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}%`;
  return bps < 0 ? `${MINUS}${percent}` : percent;
}

// The one place an amount becomes a float, for chart geometry alone. Never shown as text.
export function toChartNumber(amount: Amount): number | null {
  if (amount === null || amount === undefined) return null;
  return Number(BigInt(amount)) / Number(UNIT);
}

export type AsOfRange = { from: string; to: string };

// "3 Nov 2026 UTC", or "2 Nov 2026 to 3 Nov 2026 UTC" when chains end on different days.
export function formatAsOf(asOf: string | AsOfRange): string {
  if (typeof asOf === "string") {
    return asOf.includes("T") ? formatUtcDateTime(asOf) : formatUtcDate(asOf);
  }
  if (asOf.from === asOf.to) return formatUtcDate(asOf.from);
  return `${formatUtcDate(asOf.from).replace(/ UTC$/, "")} to ${formatUtcDate(asOf.to)}`;
}
