import type { ActivityRow, JourneyRow } from "@/lib/dataset/rows";
import type { ExchangeRow } from "@/lib/exchange-rows";

const CHAIN = "ethereum";
const SHARE_PERCENT = 40n;

// How much moves out of placed and into exchange venues on the chain's row.
const moved = (row: JourneyRow) =>
  (BigInt(row.total_supply) * SHARE_PERCENT) / 100n - BigInt(row.venue_exchange);

// A complete row with a large exchange segment: venue_exchange at about 40% of supply, with placed
// lowered by the same amount, so the parts still add up. Here in the test folder, because the
// dataset's schema rejects a row or field made up for a test.
export function largeExchangeJourney(rows: JourneyRow[]): JourneyRow[] {
  return rows.map((row) =>
    row.chain === CHAIN
      ? {
          ...row,
          venue_exchange: (BigInt(row.venue_exchange) + moved(row)).toString(),
          placed_supply: (BigInt(row.placed_supply) - moved(row)).toString(),
        }
      : row,
  );
}

// What leaves placed starts circulating, so the activity rows for the same days move with it.
export function largeExchangeActivity(
  activity: ActivityRow[],
  journey: JourneyRow[],
): ActivityRow[] {
  const byDay = new Map(journey.map((row) => [`${row.chain}|${row.day}`, row]));
  return activity.map((row) => {
    const own = byDay.get(`${row.chain}|${row.day}`);
    if (row.chain !== CHAIN || !own || row.circulating_supply === null) return row;
    return {
      ...row,
      circulating_supply: (BigInt(row.circulating_supply) + moved(own)).toString(),
    };
  });
}

const row = (entity: string, dollars: bigint): ExchangeRow => ({
  entity,
  detail: `1 wallet, at least $${dollars}`,
  amount: (dollars * 1_000_000n).toString(),
  sourceHref: `https://example.com/${entity.replace(" ", "-")}`,
  sourceText: "each wallet's label",
});

// Invented names, each holding under the segment.
export const FIXTURE_EXCHANGES = [
  row("Exchange A", 1_000_000_000n),
  row("Exchange B", 500_000_000n),
  row("Exchange C", 250_000_000n),
];
