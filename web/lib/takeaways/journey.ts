import { allChainJourney, floorBps } from "../aggregate.ts";
import { CHAIN_NAMES, REQUIRED_CHAINS } from "../definitions.ts";
import { formatBps, formatCompact, formatUtcDate, UNKNOWN_TEXT } from "../format.ts";
import type { ChainName, Definitions, JourneyRow, KpiRow } from "../dataset/rows.ts";

// "Tempo and Ethereum", or "the four chains" when every chain is in. Never "all chains" on partial
// scope, so a reader can't take two chains for the whole.
export function scopeText(chains: ChainName[]): string {
  const names = REQUIRED_CHAINS.filter((chain) => chains.includes(chain)).map(
    (chain) => CHAIN_NAMES[chain],
  );
  if (names.length === REQUIRED_CHAINS.length) return "the four chains";
  if (names.length === 0) return UNKNOWN_TEXT;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// A short heading can be cropped from its card, so below all four chains it names the ones it covers.
export function scopedHeading(chains: ChainName[], text: string): string {
  if (REQUIRED_CHAINS.every((chain) => chains.includes(chain))) return text;
  const opensWithName = Object.values(CHAIN_NAMES).some((name) => text.startsWith(name));
  const rest = opensWithName ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  return `On ${scopeText(chains)}, ${rest}`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Says what was measured: dollars that stayed in large wallets, summed over each chain's newest day.
// "Half" is decided on the exact amounts, so 49.99% never reads as half.
export function journeyTakeaway(rows: JourneyRow[], definitions: Definitions): string {
  const all = allChainJourney(rows);
  if (!all || BigInt(all.total_supply) === 0n) return UNKNOWN_TEXT;
  const placed = BigInt(all.placed_supply);
  const total = BigInt(all.total_supply);
  const share = formatBps(floorBps(placed, total));
  const doubled = placed * 2n;
  const lead = doubled > total ? "More than half" : doubled === total ? "Half" : "Under half";
  const minimum = formatCompact(definitions.placed_min_base_units);
  return sentence(
    `${lead} of supply on ${scopeText(all.chains)} (${share}) has stayed in wallets of ${minimum} or more for at least ${definitions.placed_days} days.`,
  );
}

// The same finding as the takeaway, short enough to head a card and a finding link.
export function journeyHeading(rows: JourneyRow[], definitions: Definitions): string {
  const all = allChainJourney(rows);
  const share = all && floorBps(BigInt(all.placed_supply), BigInt(all.total_supply));
  if (!all || share === null) return UNKNOWN_TEXT;
  const minimum = formatCompact(definitions.placed_min_base_units);
  return scopedHeading(
    all.chains,
    `${formatBps(share)} of supply stayed ${definitions.placed_days}+ days in ${minimum}-plus wallets.`,
  );
}

export type SeriesPoint = { day: string; total_supply: string; placed_supply: string };

// First and last day of the step line. Needs two days to be a change.
export function seriesTakeaway(series: SeriesPoint[], chains: ChainName[]): string {
  if (series.length < 2) return UNKNOWN_TEXT;
  const first = series[0];
  const last = series[series.length - 1];
  const firstShare = floorBps(BigInt(first.placed_supply), BigInt(first.total_supply));
  const lastShare = floorBps(BigInt(last.placed_supply), BigInt(last.total_supply));
  if (firstShare === null || lastShare === null) return UNKNOWN_TEXT;
  return `Placed supply on ${scopeText(chains)} was ${formatBps(firstShare)} of total on ${formatUtcDate(first.day)} and ${formatBps(lastShare)} on ${formatUtcDate(last.day)}.`;
}

// Clean volume over the 7 days to each chain's newest day. Wallets aren't added up across chains.
export function volumeTakeaway(kpis: KpiRow[]): string {
  if (kpis.length === 0) return UNKNOWN_TEXT;
  const total = kpis.reduce((sum, row) => sum + BigInt(row.clean_7d), 0n);
  return `${formatCompact(total)} of clean volume moved on ${scopeText(kpis.map((row) => row.chain))} over the 7 days to each chain's newest day.`;
}

// The share of a chain's supply held by its ten largest wallets. Unknown at zero supply.
export function top10ShareBps(
  row: Pick<JourneyRow, "top10_value" | "total_supply">,
): number | null {
  if (row.top10_value === null) return null;
  return floorBps(BigInt(row.top10_value), BigInt(row.total_supply));
}
