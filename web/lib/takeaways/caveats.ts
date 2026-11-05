import type { ChainName, Definitions } from "../dataset/rows.ts";
import { CHAIN_NAMES, DAY_ZERO } from "../definitions.ts";
import { formatCompact, formatUtcDate } from "../format.ts";
import type { Day0Scope } from "./activity.ts";

// The words of each caveat a reader needs to read a number. The views show these, and verify-output
// expects them, so a rewritten caveat has to change here and in the test that reads them.
export const PLACED_NOTE =
  "Placed measures dollars that stayed, not why. It can't show who holds them or what they are for, and a venue with no published label can count as placed, exchange custody included.";

// What stays in view on the placed segment. The note above is a tooltip on it, and stays whole in the
// card's tooltip too.
export const PLACED_PIN = "Placed can include unlabelled exchange custody.";

export const EXCHANGE_FLOOR_NOTE =
  "Exchange venues are a floor: they count only wallets a public source names. Exchange-linked wallets took their OUSD from such wallets, and could be an exchange's, its clients' or someone else's. No source says who holds them, and the named exchange rows don't count them. The part counted as placed has stayed on the chain, and use inside an exchange, if any, can't be seen.";

// What stays in view on the exchange venues segment, with the note above as a tooltip on it.
export const EXCHANGE_FLOOR_PIN = "Exchange venues are a floor.";

export const EXCHANGE_FLOOR_LINK = "How exchange-linked wallets are found";

export const HOPS_NOTE = "Hops across transactions still count more than once.";

export const SMALL_TICKET_LEAD = "Not in the dataset:";

export const SMALL_TICKET_NOTE =
  "in the week of 26 Oct 2026, Bridge’s small-ticket issuance, which issuer flows exclude, was $4.07M in 2,441 transfers to 237 recipients, against $3.13M of Tempo everyday volume. Its cause is unproven.";

// What stays in view on the waterfall. The note above stays whole in the card's tooltip, with its
// counts and what issuer flows leave out.
export const SMALL_TICKET_PIN =
  "Not in the dataset: $4.07M of Bridge small-ticket issuance, week of 26 Oct 2026, above Tempo’s $3.13M everyday volume. Cause unproven.";

export const VELOCITY_NOTE =
  "Velocity divides clean volume by circulating supply. Headline velocity divides all transfers by total supply. Because circulating supply is smaller, velocity can be higher than headline velocity even though clean volume is smaller than headline volume. They aren't two cuts of one number.";

// What stays in view on the velocity chart. The note above is a tooltip on it, and stays whole in the
// card's tooltip too.
export const VELOCITY_PIN =
  "Velocity divides by circulating supply, headline velocity by total supply.";

export const JUMPY_NOTE =
  "A small circulating supply makes velocity jumpy: the same volume over a smaller base gives a bigger percentage.";

export const NO_SWAPS_NOTE = "We don’t ingest swaps, so this view can’t show trading.";

// The velocity table's caption, the supply card's pin and its tables' caption, and that pin's tooltip.
export const WALLETS_NOTE = "Wallets, not people.";
export const WALLETS_ACROSS_CHAINS_NOTE = "Wallets, not people, and never added across chains.";
// The supply card's tooltip on its wallets note, as its wallet counts are in its tables.
export const WALLETS_TABLE_NOTE =
  "The tables' holders and active wallets count wallets, not people, and are never added across chains.";

export function issuerUnlabeledNote(chain: ChainName): string {
  return `${CHAIN_NAMES[chain]}: issuer inventory reads as zero because no wallet there is labelled.`;
}

export function exchangeCoverageNote(chain: ChainName): string {
  return `${CHAIN_NAMES[chain]}: no wallet a public source names as an exchange's holds OUSD here, so this reads as zero and the real amount is unknown.`;
}

// What stays in view, with the note above as a tooltip on it.
export function exchangeCoveragePin(chain: ChainName): string {
  return `${CHAIN_NAMES[chain]}: zero only because no exchange wallet is named.`;
}

// What stays in view on the step line, with the note below as a tooltip on it.
export function seriesStartPin(definitions: Definitions): string {
  return `Starts ${formatUtcDate(definitions.journey_first_day)}: placed supply needs ${definitions.placed_days} days of history.`;
}

// The filter now does what this note's last sentence used to point at, so that sentence is gone.
export function seriesStartNote(definitions: Definitions): string {
  return `The series starts on ${formatUtcDate(definitions.journey_first_day)}. Placed supply needs ${definitions.placed_days} days of history, so earlier days are left out. Days where a chain has no value are skipped.`;
}

export function everydayNote(definitions: Definitions): string {
  return `Everyday means under ${formatCompact(definitions.large_transfer_base_units)}, nothing more.`;
}

export function day0Note(scope: Day0Scope): string {
  return `Flows here count from Day 0, ${formatUtcDate(DAY_ZERO)}. Supply also includes mints from before it: ${formatCompact(scope.before)} of the ${formatCompact(scope.total)} total.`;
}

// What stays in view on the waterfall. day0Note stays whole in the card's tooltip.
// Under one chain it names that chain, so it reads without the card's heading.
export function day0Pin(scope: Day0Scope, chain?: string): string {
  const supply = chain ? `${chain}'s ` : "";
  return `Flows count from Day 0, ${formatUtcDate(DAY_ZERO)}; ${formatCompact(scope.before)} of ${supply}${formatCompact(scope.total)} supply predates it.`;
}

// What stays in view on the weekly bars. historyNote stays whole in the card's tooltip.
export function historyPin(history: string): string {
  return `${history}.`;
}

export function historyNote(history: string): string {
  return `Weeks end on the date shown, in UTC. ${history}.`;
}
