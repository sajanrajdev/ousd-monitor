import type { ChainName, ChainRoleRow } from "../dataset/rows.ts";
import { CHAIN_NAMES, REQUIRED_CHAINS } from "../definitions.ts";
import { UNKNOWN_TEXT } from "../format.ts";

export type Measure = ChainRoleRow["leading_for"][number];

// In the order the pipeline lists them. The sentence is what a row shows; the short name is what
// the takeaway joins. There is no trading measure, because no swaps are ingested.
export const MEASURES: Record<Measure, { sentence: string; short: string }> = {
  supply: { sentence: "Holds the most supply", short: "supply" },
  issuance: { sentence: "Most minted in 30 days", short: "issuance" },
  everyday: { sentence: "Most everyday clean volume in 30 days", short: "everyday volume" },
  dex_flow: { sentence: "Largest DEX flow in 30 days", short: "DEX flow" },
  lending_flow: { sentence: "Largest lending flow in 30 days", short: "lending flow" },
};

const MEASURE_ORDER = [
  "supply",
  "issuance",
  "everyday",
  "dex_flow",
  "lending_flow",
] as const satisfies readonly Measure[];

const isMeasure = (value: string): value is Measure => Object.hasOwn(MEASURES, value);

// An unknown value throws, so a new measure fails a test instead of printing raw.
export function leadingSentence(value: string): string {
  if (!isMeasure(value)) throw new Error(`Unknown leading_for value: ${value}`);
  return MEASURES[value].sentence;
}

// One sentence per measure the chain leads on, in the pipeline's order. None for a chain with none.
export function chainSentences(row: ChainRoleRow): string[] {
  // Checked first so that an unknown value throws instead of being left out.
  for (const value of row.leading_for) leadingSentence(value);
  return MEASURE_ORDER.filter((measure) => row.leading_for.includes(measure)).map(leadingSentence);
}

// The rows in the site's chain order, so a table doesn't depend on the file's.
export function orderedChains(rows: ChainRoleRow[]): ChainRoleRow[] {
  return [...rows].sort(
    (a, b) => REQUIRED_CHAINS.indexOf(a.chain) - REQUIRED_CHAINS.indexOf(b.chain),
  );
}

export function leadersOf(rows: ChainRoleRow[], measure: Measure): ChainName[] {
  return orderedChains(rows)
    .filter((row) => row.leading_for.includes(measure))
    .map((row) => row.chain);
}

export function differingDays(rows: ChainRoleRow[]): boolean {
  return new Set(rows.map((row) => row.as_of_day)).size > 1;
}

function list(items: string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function names(chains: ChainName[]): string {
  return list(chains.map((chain) => CHAIN_NAMES[chain]));
}

// Which chain leads on each measure, and nothing about what a chain is for. A tie names both.
export function chainRolesTakeaway(rows: ChainRoleRow[]): string {
  if (rows.length === 0) return UNKNOWN_TEXT;
  const sole = new Map<ChainName, string[]>();
  const ties: string[] = [];
  let led = 0;
  for (const measure of MEASURE_ORDER) {
    const leaders = leadersOf(rows, measure);
    if (leaders.length === 0) continue;
    led += 1;
    if (leaders.length > 1) {
      ties.push(`${names(leaders)} tie on ${MEASURES[measure].short}`);
    } else {
      sole.set(leaders[0], [...(sole.get(leaders[0]) ?? []), MEASURES[measure].short]);
    }
  }
  if (led === 0) return "No chain leads on any measure in this data.";
  const parts = [...sole].map(([chain, shorts]) =>
    shorts.length === MEASURE_ORDER.length
      ? `${CHAIN_NAMES[chain]} leads on all ${MEASURE_ORDER.length} measures`
      : `${CHAIN_NAMES[chain]} leads on ${list(shorts)}`,
  );
  const text = `${[...parts, ...ties].join("; ")}.`;
  return differingDays(rows) ? `${text} Chains end on different days.` : text;
}

// The text summary: each chain's own sentences, so a reader sees what it leads on in full.
export function chainRolesSummary(rows: ChainRoleRow[]): string {
  const each = orderedChains(rows).map((row) => {
    const sentences = chainSentences(row);
    return `${CHAIN_NAMES[row.chain]}: ${
      sentences.length
        ? `${sentences.join(". ")}.`
        : `leads on none of the ${MEASURE_ORDER.length} measures.`
    }`;
  });
  const days = differingDays(rows)
    ? " The as-of day differs by chain, so read each row on its own day."
    : "";
  return `Each chain on its own newest day. A chain leads when it has the most of that measure. ${each.join(" ")}${days}`;
}
