import { TableCard } from "./chart-card";
import { Outbound } from "./methodology-tables";
import type { Dataset, DatasetState } from "@/lib/dataset";
import { CHAIN_NAMES } from "@/lib/definitions";
import { formatExact, formatUtcDate } from "@/lib/format";

type Holding = Dataset["labels"]["exchange_holdings"][number];

function newestDay(holdings: Holding[]): string | null {
  return holdings.reduce<string | null>(
    (newest, row) => (newest === null || row.day > newest ? row.day : newest),
    null,
  );
}

// Each named exchange, so a name here sits in the labels block beside the sources that name it.
export function ExchangeHoldingsCard({
  holdings,
  state,
  fallbackAsOf,
}: {
  holdings: Holding[];
  state: DatasetState;
  fallbackAsOf: string;
}) {
  return (
    <div data-labels-table data-exchange-holdings className="mt-4">
      <TableCard
        level={3}
        takeaway="What wallets a public source names as an exchange's hold, which is a floor."
        source="Chain data and public labels"
        asOf={newestDay(holdings) ?? fallbackAsOf}
        definitionHref="/methodology/#named-labels"
        frameWord={state.frameWord}
        summary="Only named wallets count, so custody no source names isn't here. Each name's source is in the named labels table."
        table={{
          caption: "Exchange holdings, newest day per chain",
          columns: [
            { key: "entity", label: "Exchange" },
            { key: "chain", label: "Chain" },
            { key: "day", label: "Day" },
            { key: "wallets", label: "Named wallets", numeric: true },
            { key: "balance", label: "Holds, at least", numeric: true },
          ],
          rows: holdings.map((row) => ({
            entity: row.entity,
            chain: CHAIN_NAMES[row.chain],
            day: formatUtcDate(row.day),
            wallets: row.wallets.toLocaleString("en-US"),
            balance: formatExact(row.balance),
          })),
        }}
      />
    </div>
  );
}

// An exchange's own page, with the type and day a label carries. It names no wallet.
export function ExchangeListingsCard({
  listings,
  state,
  fallbackAsOf,
}: {
  listings: Dataset["labels"]["exchange_listings"];
  state: DatasetState;
  fallbackAsOf: string;
}) {
  const newest = listings.reduce<string | null>(
    (latest, row) => (latest === null || row.date_checked > latest ? row.date_checked : latest),
    null,
  );
  return (
    <div data-labels-table data-exchange-listings className="mt-4">
      <TableCard
        level={3}
        takeaway="Exchanges whose own page says they support OUSD."
        source="Each exchange's own page, linked in each row"
        asOf={newest ?? fallbackAsOf}
        definitionHref="/methodology/#named-labels"
        frameWord={state.frameWord}
        summary="A listing names no wallet, so it says nothing about what an exchange holds."
        table={{
          caption: "Exchange listings",
          columns: [
            { key: "entity", label: "Exchange" },
            { key: "type", label: "Source type" },
            { key: "source", label: "Source" },
            { key: "checked", label: "Checked" },
          ],
          rows: listings.map((row) => ({
            entity: row.entity,
            type: row.source_type,
            source: <Outbound href={row.source_url}>Its page</Outbound>,
            checked: formatUtcDate(row.date_checked),
          })),
        }}
      />
    </div>
  );
}
