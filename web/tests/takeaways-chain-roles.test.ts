import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChainRoleRow } from "@/lib/dataset";
import { UNKNOWN_TEXT } from "@/lib/format";
import {
  chainRolesHeading,
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

describe("the chain roles heading", () => {
  const led = (leads: Partial<Record<ChainRoleRow["chain"], ChainRoleRow["leading_for"]>>) =>
    (["tempo", "ethereum", "base", "solana"] as const).map((chain) =>
      row({ chain, leading_for: leads[chain] ?? [] }),
    );
  const words = (text: string) => text.split(/\s+/).length;

  it("reads the sample's leader from its rows", () => {
    const leader = sample.filter((r) => r.leading_for.length === 5);
    expect(leader).toHaveLength(1);
    const name = leader[0].chain.charAt(0).toUpperCase() + leader[0].chain.slice(1);
    expect(chainRolesHeading(sample)).toBe(`${name} leads on all five measures.`);
  });

  it("two chains: the one with more first, by count, and the other by name", () => {
    expect(
      chainRolesHeading(
        led({
          tempo: ["supply", "issuance", "dex_flow", "lending_flow"],
          solana: ["everyday"],
        }),
      ),
    ).toBe("Tempo leads on four measures; Solana on everyday volume.");
    expect(
      chainRolesHeading(
        led({
          tempo: ["everyday"],
          solana: ["supply", "issuance", "dex_flow", "lending_flow"],
        }),
      ),
    ).toBe("Solana leads on four measures; Tempo on everyday volume.");
    expect(chainRolesHeading(led({ tempo: ["supply"], base: ["dex_flow"] }))).toBe(
      "Tempo leads on supply; Base on DEX flow.",
    );
    expect(
      chainRolesHeading(
        led({ tempo: ["supply", "issuance", "everyday"], base: ["dex_flow", "lending_flow"] }),
      ),
    ).toBe("Tempo leads on three measures; Base on two measures.");
  });

  it("no leader says so, and no rows is the unknown text", () => {
    expect(chainRolesHeading(led({}))).toBe("No chain leads on any measure in this data.");
    expect(chainRolesHeading([])).toBe(UNKNOWN_TEXT);
  });

  it("one chain on all five, and on some", () => {
    expect(
      chainRolesHeading(
        led({ base: ["supply", "issuance", "everyday", "dex_flow", "lending_flow"] }),
      ),
    ).toBe("Base leads on all five measures.");
    expect(chainRolesHeading(led({ base: ["supply"] }))).toBe("Base leads on supply.");
    expect(chainRolesHeading(led({ base: ["supply", "dex_flow"] }))).toBe(
      "Base leads on two measures.",
    );
  });

  it("a tie names both, beside any measure one leads alone", () => {
    expect(chainRolesHeading(led({ base: ["dex_flow"], solana: ["dex_flow"] }))).toBe(
      "Base and Solana tie on DEX flow.",
    );
    expect(chainRolesHeading(led({ base: ["dex_flow", "supply"], ethereum: ["dex_flow"] }))).toBe(
      "Base leads on supply; Ethereum and Base tie on DEX flow.",
    );
    const everything = ["supply", "issuance", "everyday", "dex_flow", "lending_flow"] as const;
    expect(chainRolesHeading(led({ base: [...everything], solana: [...everything] }))).toBe(
      "Base and Solana tie on all five measures.",
    );
  });

  it("past two named chains it counts them, and a tie with a measure each does too", () => {
    expect(
      chainRolesHeading(led({ tempo: ["supply"], base: ["dex_flow"], solana: ["everyday"] })),
    ).toBe("Leadership is split across 3 chains.");
    expect(
      chainRolesHeading(
        led({
          tempo: ["supply"],
          ethereum: ["issuance"],
          base: ["dex_flow"],
          solana: ["everyday"],
        }),
      ),
    ).toBe("Leadership is split across 4 chains.");
    expect(
      chainRolesHeading(led({ tempo: ["supply", "dex_flow"], base: ["everyday", "dex_flow"] })),
    ).toBe("Leadership is split across 2 chains.");
    expect(
      chainRolesHeading(led({ tempo: ["dex_flow"], base: ["dex_flow"], solana: ["dex_flow"] })),
    ).toBe("Leadership is split across 3 chains.");
  });

  it("names its chains at partial scope, a chain keeps its capital, and it never says all chains", () => {
    const two = [
      row({ chain: "tempo", leading_for: [] }),
      row({ chain: "ethereum", leading_for: ["supply"] }),
    ];
    expect(chainRolesHeading(two)).toBe("On Tempo and Ethereum, Ethereum leads on supply.");
    const none = [row({ chain: "tempo" }), row({ chain: "ethereum" })];
    expect(chainRolesHeading(none)).toBe(
      "On Tempo and Ethereum, no chain leads on any measure in this data.",
    );
    const one = [row({ chain: "base", leading_for: ["supply"] })];
    expect(chainRolesHeading(one)).toBe("On Base, Base leads on supply.");
    expect(chainRolesHeading(two)).not.toMatch(/all chains/i);
  });

  it("is at most 12 words past any prefix, in its longest forms", () => {
    const longest = [
      led({ ethereum: ["everyday", "lending_flow"], solana: ["lending_flow"] }),
      led({
        ethereum: ["everyday", "supply", "issuance", "lending_flow"],
        solana: ["lending_flow"],
      }),
      led({ ethereum: ["everyday"], solana: ["lending_flow"] }),
      led({}),
      sample,
    ];
    for (const rows of longest) expect(words(chainRolesHeading(rows))).toBeLessThanOrEqual(12);
  });

  it("a change in who leads changes the sentence with no other edit", () => {
    const before = chainRolesHeading(led({ tempo: ["supply"] }));
    expect(chainRolesHeading(led({ base: ["supply"] }))).not.toBe(before);
  });

  it("never says what a chain is for", () => {
    const text = chainRolesHeading(led({ tempo: ["supply"], base: ["dex_flow"] }));
    expect(text).not.toMatch(/trading|settlement|used for|is for/i);
  });
});
