import type { Dataset } from "./dataset/load.ts";
import { formatFloorDollars } from "./format.ts";

type Labels = Pick<Dataset["labels"], "data" | "exchange_holdings" | "exchange_listings">;

// One named exchange as the main page shows it. The views and verify-output both read this, so a
// name only reaches the page with its source. The unnamed exchange-linked band is never here: it
// has no entity to read.
export type ExchangeRow = {
  entity: string;
  detail: string;
  sourceHref: string;
  sourceText: string;
};

const LABELS_HREF = "/methodology/#named-labels";
const EACH_WALLET = "each wallet's label";

function wallets(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "wallet" : "wallets"}`;
}

export function exchangeRows({
  data,
  exchange_holdings,
  exchange_listings,
}: Labels): ExchangeRow[] {
  const labeled = new Set(
    data.filter((row) => row.category === "exchange").map((row) => row.entity),
  );
  const entities = new Set([
    ...exchange_holdings.map((row) => row.entity),
    ...exchange_listings.map((row) => row.entity),
  ]);
  return [...entities].sort().map((entity) => {
    const held = exchange_holdings.filter((row) => row.entity === entity);
    if (held.length > 0) {
      const count = held.reduce((sum, row) => sum + row.wallets, 0);
      const balance = held.reduce((sum, row) => sum + BigInt(row.balance), 0n);
      return {
        entity,
        detail: `${wallets(count)}, at least ${formatFloorDollars(balance.toString())}`,
        sourceHref: LABELS_HREF,
        sourceText: EACH_WALLET,
      };
    }
    if (labeled.has(entity)) {
      return {
        entity,
        detail: "labeled wallets hold none",
        sourceHref: LABELS_HREF,
        sourceText: EACH_WALLET,
      };
    }
    // A listing ties the name to OUSD and to no wallet, so this row claims no wallet.
    return {
      entity,
      detail: "no wallet labeled",
      sourceHref: exchange_listings.find((row) => row.entity === entity)!.source_url,
      sourceText: "its OUSD listing",
    };
  });
}
