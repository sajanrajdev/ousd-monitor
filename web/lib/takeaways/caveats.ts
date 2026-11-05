import type { ChainName, Definitions } from "../dataset/rows.ts";
import { CHAIN_NAMES, DAY_ZERO } from "../definitions.ts";
import { formatCompact, formatUtcDate } from "../format.ts";
import type { Day0Scope } from "./activity.ts";

// The words of each caveat a reader needs to read a number. The views show these, and verify-output
// expects them, so a rewritten caveat has to change here and in the test that reads them.
export const PLACED_NOTE =
  "Placed measures dollars that stayed, not why. It can't show who holds them or what they are for, and a venue with no published label can count as placed, exchange custody included.";

// What stays in view on the placed segment. The note above stays whole in the card's popover.
export const PLACED_PIN =
  "Placed measures dollars that stayed, not why. A venue with no published label can count as placed, exchange custody included.";

export const EXCHANGE_FLOOR_NOTE =
  "Exchange venues are a floor: they count only wallets a public source names. Exchange-linked wallets took their OUSD from such wallets, and could be an exchange's, its clients' or someone else's. No source says who holds them, and the named exchange rows don't count them. The part counted as placed has stayed on the chain, and use inside an exchange, if any, can't be seen.";

export const EXCHANGE_FLOOR_LINK = "How exchange-linked wallets are found";

export const HOPS_NOTE = "Hops across transactions still count more than once.";

export const SMALL_TICKET_LEAD = "Not in the dataset:";

export const SMALL_TICKET_NOTE =
  "in the week of 26 Oct 2026, Bridge’s small-ticket issuance, which issuer flows exclude, was $4.07M in 2,441 transfers to 237 recipients, against $3.13M of Tempo everyday volume. Its cause is unproven.";

// What stays in view on the waterfall. The note above stays whole in the card's popover, with its
// counts and what issuer flows leave out.
export const SMALL_TICKET_PIN =
  "Not in the dataset: Bridge’s small-ticket issuance, week of 26 Oct 2026: $4.07M, against $3.13M of Tempo everyday volume. Its cause is unproven.";

export const VELOCITY_NOTE =
  "Velocity divides clean volume by circulating supply. Headline velocity divides all transfers by total supply. Because circulating supply is smaller, velocity can be higher than headline velocity even though clean volume is smaller than headline volume. They aren't two cuts of one number.";

export const NO_SWAPS_NOTE = "We don’t ingest swaps, so this view can’t show trading.";

// Two cards count wallets. The one beside the supply parts also rules out adding them up.
export const WALLETS_NOTE = "Wallets, not people.";
export const WALLETS_ACROSS_CHAINS_NOTE = "Wallets, not people, and never added across chains.";

export function issuerUnlabeledNote(chain: ChainName): string {
  return `${CHAIN_NAMES[chain]}: issuer inventory reads as zero because no wallet there is labelled.`;
}

export function exchangeCoverageNote(chain: ChainName): string {
  return `${CHAIN_NAMES[chain]}: no wallet a public source names as an exchange's holds OUSD here, so this reads as zero and the real amount is unknown.`;
}

export function seriesStartPin(definitions: Definitions): string {
  return `The series starts on ${formatUtcDate(definitions.journey_first_day)}. Placed supply needs ${definitions.placed_days} days of history, so earlier days are left out.`;
}

// The filter now does what this note's last sentence used to point at, so that sentence is gone.
export function seriesStartNote(definitions: Definitions): string {
  return `${seriesStartPin(definitions)} Days where a chain has no value are skipped.`;
}

export function everydayNote(definitions: Definitions): string {
  return `Everyday means under ${formatCompact(definitions.large_transfer_base_units)}, nothing more.`;
}

export function day0Note(scope: Day0Scope): string {
  return `Flows here count from Day 0, ${formatUtcDate(DAY_ZERO)}. Supply also includes mints from before it: ${formatCompact(scope.before)} of the ${formatCompact(scope.total)} total.`;
}

// What stays in view on the waterfall. day0Note stays whole in the card's popover.
export function day0Pin(scope: Day0Scope): string {
  return `Flows count from Day 0, ${formatUtcDate(DAY_ZERO)}. ${formatCompact(scope.before)} of the ${formatCompact(scope.total)} total supply predates it.`;
}

// What stays in view on the weekly bars. historyNote stays whole in the card's popover.
export function historyPin(history: string): string {
  return `${history}.`;
}

export function historyNote(history: string): string {
  return `Weeks end on the date shown, in UTC. ${history}.`;
}
