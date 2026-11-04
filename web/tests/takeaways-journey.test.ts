import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Definitions, JourneyRow } from "@/lib/dataset/rows";
import { UNKNOWN_TEXT } from "@/lib/format";
import {
  journeyTakeaway,
  scopeText,
  seriesTakeaway,
  top10ShareBps,
  volumeTakeaway,
} from "@/lib/takeaways/journey";

const blocked: string[] = JSON.parse(readFileSync("scripts/blocked-names.json", "utf8"));
const definitions = { placed_days: 14, placed_min_base_units: "1000000000000" } as Definitions;

function row(chain: JourneyRow["chain"], total: string, placed: string): JourneyRow {
  return {
    chain,
    day: "2026-11-03",
    total_supply: total,
    issuer_inventory: "0",
    placed_supply: placed,
    venue_dex: "0",
    venue_lending: "0",
    venue_exchange: "0",
    free_floating: (BigInt(total) - BigInt(placed)).toString(),
    placed_wallets: 1,
    holders: 1,
    holders_over_1m: 1,
    top10_value: null,
    issuer_labeled: true,
  };
}

describe("journey takeaway", () => {
  it("reads under half, half and more than half on the exact amounts", () => {
    expect(journeyTakeaway([row("tempo", "10000", "4999")], definitions)).toMatch(/^Under half/);
    expect(journeyTakeaway([row("tempo", "10000", "5000")], definitions)).toMatch(/^Half of/);
    expect(journeyTakeaway([row("tempo", "10000", "5001")], definitions)).toMatch(
      /^More than half/,
    );
    // 50.009% floors to 50.00% but is not half.
    expect(journeyTakeaway([row("tempo", "100000", "50009")], definitions)).toMatch(
      /^More than half/,
    );
  });

  it("states what was measured, with the threshold and days from the definitions", () => {
    expect(journeyTakeaway([row("tempo", "10000", "6000")], definitions)).toBe(
      "More than half of supply on Tempo (60.00%) has stayed in wallets of $1M or more for at least 14 days.",
    );
  });

  it("names the chains in scope, with one, four, and never 'all chains' on partial scope", () => {
    const one = journeyTakeaway([row("base", "10", "5")], definitions);
    expect(one).toContain("on Base");
    const two = journeyTakeaway([row("ethereum", "10", "5"), row("tempo", "10", "5")], definitions);
    expect(two).toContain("Tempo and Ethereum");
    const four = journeyTakeaway(
      (["tempo", "ethereum", "base", "solana"] as const).map((c) => row(c, "10", "5")),
      definitions,
    );
    expect(four).toContain("the four chains");
    for (const text of [one, two, four]) {
      expect(text).not.toMatch(/all chains/i);
      for (const name of blocked) expect(text).not.toContain(name);
    }
    expect(scopeText(["tempo", "ethereum", "base"])).toBe("Tempo, Ethereum and Base");
  });

  it("is unknown with no rows or no supply", () => {
    expect(journeyTakeaway([], definitions)).toBe(UNKNOWN_TEXT);
    expect(journeyTakeaway([row("tempo", "0", "0")], definitions)).toBe(UNKNOWN_TEXT);
  });
});

describe("other takeaways", () => {
  it("series needs two days", () => {
    const point = { day: "2026-10-14", total_supply: "100", placed_supply: "25" };
    expect(seriesTakeaway([point], ["tempo"])).toBe(UNKNOWN_TEXT);
    expect(
      seriesTakeaway([point, { ...point, day: "2026-11-03", placed_supply: "50" }], ["tempo"]),
    ).toBe(
      "Placed supply on Tempo was 25.00% of total on 14 Oct 2026 UTC and 50.00% on 3 Nov 2026 UTC.",
    );
    expect(seriesTakeaway([{ ...point, total_supply: "0" }, point], ["tempo"])).toBe(UNKNOWN_TEXT);
  });

  it("volume is unknown with no rows", () => {
    expect(volumeTakeaway([])).toBe(UNKNOWN_TEXT);
  });

  it("top-10 share is unknown for null or zero supply", () => {
    expect(top10ShareBps({ top10_value: null, total_supply: "10" })).toBeNull();
    expect(top10ShareBps({ top10_value: "0", total_supply: "0" })).toBeNull();
    expect(top10ShareBps({ top10_value: "8", total_supply: "10" })).toBe(8000);
  });
});
