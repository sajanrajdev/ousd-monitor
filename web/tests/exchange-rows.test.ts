import { describe, expect, it } from "vitest";
import { exchangeRows } from "@/lib/exchange-rows";
import type { Dataset } from "@/lib/dataset/load";

type Labels = Dataset["labels"];
const label = (entity: string, category: Labels["data"][number]["category"]) =>
  ({
    chain: "base",
    entity,
    category,
    source_type: "explorer_tag",
    source_url: "https://basescan.org/address/0xabc",
    confidence: "high",
    date_checked: "2026-11-04",
  }) as Labels["data"][number];
const holding = (chain: "base" | "ethereum", wallets: number, balance: string) => ({
  chain,
  day: "2026-11-03",
  entity: "Coinbase",
  wallets,
  balance,
});
const listing = (entity: string) => ({
  entity,
  source_type: "exchange_listing" as const,
  source_url: `https://example.com/${entity}`,
  date_checked: "2026-11-04",
});

describe("exchangeRows", () => {
  it("adds a named exchange's wallets across chains, rounding the floor down", () => {
    const rows = exchangeRows({
      data: [label("Coinbase", "exchange")],
      exchange_holdings: [holding("base", 2, "1999999"), holding("ethereum", 5, "345579999999")],
      exchange_listings: [listing("Coinbase")],
    });
    expect(rows).toEqual([
      {
        entity: "Coinbase",
        detail: "7 wallets, at least $345,581",
        sourceHref: "/methodology/#named-labels",
        sourceText: "each wallet's label",
      },
    ]);
  });

  it("never rounds a floor up", () => {
    const rows = exchangeRows({
      data: [label("Coinbase", "exchange")],
      exchange_holdings: [holding("base", 1, "1999999")],
      exchange_listings: [],
    });
    expect(rows[0].detail).toBe("1 wallet, at least $1");
  });

  it("says no wallet is labeled for a listed exchange, with the listing as its source", () => {
    const rows = exchangeRows({
      data: [],
      exchange_holdings: [],
      exchange_listings: [listing("Kraken")],
    });
    expect(rows).toEqual([
      {
        entity: "Kraken",
        detail: "no wallet labeled",
        sourceHref: "https://example.com/Kraken",
        sourceText: "its OUSD listing",
      },
    ]);
  });

  it("doesn't say wallets aren't labeled when they are and hold nothing", () => {
    const rows = exchangeRows({
      data: [label("Coinbase", "exchange")],
      exchange_holdings: [],
      exchange_listings: [listing("Coinbase")],
    });
    expect(rows[0].detail).toBe("labeled wallets hold none");
    expect(rows[0].sourceHref).toBe("/methodology/#named-labels");
  });

  it("takes no name from any other label", () => {
    const rows = exchangeRows({
      data: [label("Some Pool", "dex"), label("Some Issuer", "issuer")],
      exchange_holdings: [],
      exchange_listings: [],
    });
    expect(rows).toEqual([]);
  });
});
