import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { Definitions, JourneyRow } from "@/lib/dataset/rows";
import { formatBps, formatCompact, UNKNOWN_TEXT } from "@/lib/format";
import {
  journeyHeading,
  journeyTakeaway,
  scopedHeading,
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
    placed_exchange_linked: "0",
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

describe("the journey heading", () => {
  const sampleOf = (name: "complete" | "partial") => {
    const dir = join(process.cwd(), "fixtures/dataset", name);
    return {
      rows: JSON.parse(readFileSync(join(dir, "journey.json"), "utf8")).data as JourneyRow[],
      definitions: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
        .definitions as Definitions,
    };
  };

  // Worked out here from the rows, with nothing from the code under test but the formatting.
  const expectedShare = (rows: JourneyRow[]) => {
    const newest = new Map<string, JourneyRow>();
    for (const r of rows) {
      if (!newest.has(r.chain) || r.day > newest.get(r.chain)!.day) newest.set(r.chain, r);
    }
    let placed = 0n;
    let total = 0n;
    for (const r of newest.values()) {
      placed += BigInt(r.placed_supply);
      total += BigInt(r.total_supply);
    }
    return formatBps(Number((placed * 10_000n) / total));
  };

  it("reads its figure, threshold and days from the dataset, in at most 12 words", () => {
    const { rows, definitions } = sampleOf("complete");
    const minimum = formatCompact(definitions.placed_min_base_units);
    const text = journeyHeading(rows, definitions);
    expect(text).toBe(
      `${expectedShare(rows)} of supply stayed ${definitions.placed_days}+ days in ${minimum}-plus wallets.`,
    );
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(12);
  });

  it("prefixes its chains at partial scope, and never says all", () => {
    const { rows, definitions } = sampleOf("partial");
    const text = journeyHeading(rows, definitions);
    expect(text.startsWith("On Tempo and Ethereum, ")).toBe(true);
    expect(text).toContain(expectedShare(rows));
    expect(text).not.toMatch(/\ball\b/i);
    expect(text.replace("On Tempo and Ethereum, ", "").split(/\s+/).length).toBeLessThanOrEqual(12);
  });

  it("names a single chain", () => {
    expect(journeyHeading([row("base", "10000", "2500")], definitions)).toBe(
      "On Base, 25.00% of supply stayed 14+ days in $1M-plus wallets.",
    );
  });

  it("takes other thresholds from the definitions, not a hard-coded $1M or 14", () => {
    const other = { placed_days: 30, placed_min_base_units: "2500000000000" } as Definitions;
    expect(journeyHeading([row("base", "10000", "2500")], other)).toBe(
      "On Base, 25.00% of supply stayed 30+ days in $2.5M-plus wallets.",
    );
  });

  it("is unknown with no rows or no supply, never a zero", () => {
    expect(journeyHeading([], definitions)).toBe(UNKNOWN_TEXT);
    expect(journeyHeading([row("tempo", "0", "0")], definitions)).toBe(UNKNOWN_TEXT);
  });

  it("shows zero placed as 0.00%, and all of it as 100.00%", () => {
    expect(journeyHeading([row("tempo", "10000", "0")], definitions)).toContain("0.00% of supply");
    expect(journeyHeading([row("tempo", "10000", "10000")], definitions)).toContain(
      "100.00% of supply",
    );
  });

  it("floors at the boundary, so 49.999% never reads as 50%", () => {
    expect(journeyHeading([row("tempo", "100000", "49999")], definitions)).toContain("49.99%");
  });

  it("a large change in placed moves the figure with no other edit", () => {
    const { rows, definitions: defined } = sampleOf("complete");
    const before = journeyHeading(rows, defined);
    const moved = rows.map((r) => ({ ...r, placed_supply: "0" }));
    expect(journeyHeading(moved, defined)).not.toBe(before);
    expect(journeyHeading(moved, defined)).toContain("0.00% of supply");
  });

  it("agrees with the long takeaway's figure", () => {
    const { rows, definitions: defined } = sampleOf("complete");
    expect(journeyTakeaway(rows, defined)).toContain(expectedShare(rows));
    expect(journeyHeading(rows, defined)).toContain(expectedShare(rows));
  });
});

describe("a scoped heading", () => {
  it("adds nothing at four chains, and lower-cases what follows a prefix", () => {
    const all = ["tempo", "ethereum", "base", "solana"] as const;
    expect(scopedHeading([...all], "Everyday volume.")).toBe("Everyday volume.");
    expect(scopedHeading(["tempo"], "Everyday volume.")).toBe("On Tempo, everyday volume.");
  });

  it("keeps a chain's capital", () => {
    expect(scopedHeading(["tempo", "base"], "Base leads on supply.")).toBe(
      "On Tempo and Base, Base leads on supply.",
    );
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
