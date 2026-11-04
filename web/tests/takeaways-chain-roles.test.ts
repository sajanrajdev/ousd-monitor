import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChainRoleRow } from "@/lib/dataset";
import { UNKNOWN_TEXT } from "@/lib/format";
import {
  chainRolesTakeaway,
  chainSentences,
  differingDays,
  leadersOf,
  leadingSentence,
  MEASURES,
} from "@/lib/takeaways/chain-roles";

const sample: ChainRoleRow[] = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures/dataset/complete/chain_roles.json"), "utf8"),
).data;

const row = (over: Partial<ChainRoleRow>): ChainRoleRow => ({
  ...sample[0],
  leading_for: [],
  ...over,
});

describe("chain role sentences", () => {
  it("gives each leading_for value its exact sentence", () => {
    expect(leadingSentence("supply")).toBe("Holds the most supply");
    expect(leadingSentence("issuance")).toBe("Most minted in 30 days");
    expect(leadingSentence("everyday")).toBe("Most everyday clean volume in 30 days");
    expect(leadingSentence("dex_flow")).toBe("Largest DEX flow in 30 days");
    expect(leadingSentence("lending_flow")).toBe("Largest lending flow in 30 days");
  });

  it("fails on an unknown value instead of printing it raw", () => {
    expect(() => leadingSentence("trading")).toThrow(/Unknown leading_for/);
    expect(() => leadingSentence("toString")).toThrow(/Unknown leading_for/);
    expect(() => chainSentences(row({ leading_for: ["settlement" as never] }))).toThrow(
      /Unknown leading_for/,
    );
  });

  it("covers every value the schema allows", () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), "../pipeline/ousd/schemas/chain_roles.schema.json"), "utf8"),
    );
    const allowed = schema.properties.data.items.properties.leading_for.items.enum;
    expect(Object.keys(MEASURES)).toEqual(allowed);
  });

  it("gives a chain with none no sentence", () => {
    expect(chainSentences(row({ leading_for: [] }))).toEqual([]);
  });
});

describe("the chain roles takeaway", () => {
  it("names the one chain that leads on everything in the sample", () => {
    expect(chainRolesTakeaway(sample)).toBe(
      "Ethereum leads on all 5 measures. Chains end on different days.",
    );
  });

  it("is the unknown text with no rows, and says so when nothing leads", () => {
    expect(chainRolesTakeaway([])).toBe(UNKNOWN_TEXT);
    expect(chainRolesTakeaway([row({ chain: "base" })])).toBe(
      "No chain leads on any measure in this data.",
    );
  });

  it("names both chains in a tie", () => {
    const rows = [
      row({ chain: "base", leading_for: ["dex_flow", "supply"] }),
      row({ chain: "ethereum", leading_for: ["dex_flow"] }),
    ];
    expect(leadersOf(rows, "dex_flow")).toEqual(["ethereum", "base"]);
    expect(chainRolesTakeaway(rows)).toBe(
      "Base leads on supply; Ethereum and Base tie on DEX flow.",
    );
  });

  it("joins a three-way tie with commas", () => {
    const rows = (["base", "ethereum", "solana"] as const).map((chain) =>
      row({ chain, leading_for: ["dex_flow"] }),
    );
    expect(chainRolesTakeaway(rows)).toBe("Ethereum, Base and Solana tie on DEX flow.");
  });

  it("lists several measures for one chain and other chains separately", () => {
    const rows = [
      row({ chain: "ethereum", leading_for: ["supply", "issuance", "everyday"] }),
      row({ chain: "solana", leading_for: ["lending_flow"] }),
    ];
    expect(chainRolesTakeaway(rows)).toBe(
      "Ethereum leads on supply, issuance and everyday volume; Solana leads on lending flow.",
    );
  });

  it("says the days differ only when they do", () => {
    expect(differingDays(sample)).toBe(true);
    expect(
      differingDays([row({ as_of_day: "2026-11-03" }), row({ as_of_day: "2026-11-03" })]),
    ).toBe(false);
    expect(chainRolesTakeaway([row({ leading_for: ["supply"] })])).not.toContain("different days");
  });

  it("never says what a chain is for", () => {
    const all = (Object.keys(MEASURES) as (keyof typeof MEASURES)[]).flatMap((measure) => [
      leadingSentence(measure),
      MEASURES[measure].short,
    ]);
    for (const text of [...all, chainRolesTakeaway(sample)]) {
      expect(text).not.toMatch(/trading|settlement|used for|is for/i);
    }
  });
});
