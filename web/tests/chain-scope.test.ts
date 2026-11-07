import { describe, expect, it } from "vitest";
import { chainOptions } from "@/lib/chain-scope";

describe("chainOptions", () => {
  it('gives "All" and four chains on a complete dataset', () => {
    const options = chainOptions(["tempo", "ethereum", "base", "solana"]);
    expect(options.map((option) => option.label)).toEqual([
      "All",
      "Tempo",
      "Ethereum",
      "Base",
      "Solana",
    ]);
    expect(options[0]).toMatchObject({
      value: "all",
      chains: ["tempo", "ethereum", "base", "solana"],
    });
    expect(options[1]).toEqual({ value: "tempo", label: "Tempo", chains: ["tempo"] });
  });

  it('gives "All covered" and only the chains present on a partial dataset, never "All"', () => {
    const options = chainOptions(["solana", "tempo"]);
    expect(options.map((option) => option.label)).toEqual(["All covered", "Tempo", "Solana"]);
    expect(options[0].chains).toEqual(["tempo", "solana"]);
  });

  it("keeps one order, whatever order the dataset lists them in", () => {
    const labels = (chains: Parameters<typeof chainOptions>[0]) =>
      chainOptions(chains).map((option) => option.value);
    expect(labels(["base", "ethereum"])).toEqual(labels(["ethereum", "base"]));
  });

  it("reads the same from the partial sample's own list", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(readFileSync("fixtures/dataset/partial/manifest.json", "utf8"));
    expect(chainOptions(manifest.coverage.chains_included)[0].label).toBe("All covered");
  });
});
