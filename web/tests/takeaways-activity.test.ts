import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActivityRow, KpiRow } from "@/lib/dataset";
import { formatBps, formatCompact, formatUtcDate, UNKNOWN_TEXT } from "@/lib/format";
import {
  activityChains,
  barPosition,
  historyDays,
  historyLabel,
  perChain,
  stepFigure,
  velocityTakeaway,
  waterfall,
  waterfallAmount,
  waterfallHeading,
  waterfallTakeaway,
  weeklyEveryday,
  weeklyHeading,
  weeklyTakeaway,
} from "@/lib/takeaways/activity";

const sample = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "fixtures/dataset/complete", name), "utf8"));
const activity: ActivityRow[] = sample("activity.json").data;
const kpis: KpiRow[] = sample("summary.json").kpis;

const shortDate = (day: string) => formatUtcDate(day).replace(/ \d{4} UTC$/, "");

const zeroRow = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  ...activity[0],
  headline_value: "0",
  minted: "0",
  burned: "0",
  fees: "0",
  fee_liquidity: "0",
  issuer_flows: "0",
  same_entity: "0",
  same_tx_netting: "0",
  dex_flow: "0",
  lending_flow: "0",
  clean_large: "0",
  clean_everyday: "0",
  ...over,
});

describe("the waterfall", () => {
  it("sums back to headline exactly on the sample, ending at clean large and clean everyday", () => {
    const w = waterfall(activity)!;
    expect(w).not.toBeNull();
    const removed = w.steps
      .filter((step) => step.kind === "removal")
      .reduce((sum, step) => sum + BigInt(step.amount), 0n);
    const clean =
      BigInt(waterfallAmount(w, "clean_large")) + BigInt(waterfallAmount(w, "clean_everyday"));
    expect(removed + clean).toBe(BigInt(w.headline));
    expect(w.steps.map((step) => step.key)).toEqual([
      "headline_value",
      "minted",
      "burned",
      "fees",
      "fee_liquidity",
      "issuer_flows",
      "same_entity",
      "same_tx_netting",
      "dex_flow",
      "lending_flow",
      "clean_large",
      "clean_everyday",
    ]);
    const total = (field: "clean_large" | "clean_everyday") =>
      activity.reduce((sum, row) => sum + BigInt(row[field]), 0n).toString();
    expect(waterfallAmount(w, "clean_large")).toBe(total("clean_large"));
    expect(waterfallAmount(w, "clean_everyday")).toBe(total("clean_everyday"));
    expect(BigInt(w.steps.at(-1)!.to)).toBe(clean);
  });

  it("keeps a part at 0 as a step, and a $21 fee beside a $2B headline visible", () => {
    const row = zeroRow({
      headline_value: "2000000000000000",
      fees: "21000000",
      clean_large: "1999999979000000",
    });
    const w = waterfall([row])!;
    expect(w.steps.find((step) => step.key === "minted")!.amount).toBe("0");
    const fee = w.steps.find((step) => step.key === "fees")!;
    expect(barPosition(fee, w.headline).width).toBe(1);
    expect(
      barPosition(
        w.steps.find((step) => step.key === "minted")!,
        w.headline,
      ).width,
    ).toBe(0);
  });

  it("clamps a bar that would start below zero", () => {
    const step = {
      key: "fees",
      label: "Fees",
      kind: "removal",
      amount: "5",
      from: "-5",
      to: "0",
    } as const;
    expect(barPosition(step, "100").left).toBe(0);
  });

  it("is null when the parts don't add up, or there is no headline", () => {
    expect(waterfall([zeroRow({ headline_value: "100", clean_large: "99" })])).toBeNull();
    expect(waterfall([zeroRow()])).toBeNull();
    expect(waterfall([])).toBeNull();
  });
});

describe("the takeaways", () => {
  it("states what is left, at the boundaries", () => {
    expect(waterfallTakeaway(null)).toBe(UNKNOWN_TEXT);
    const all = waterfallTakeaway(
      waterfall([zeroRow({ headline_value: "100000000", clean_large: "100000000" })]),
    );
    expect(all).toContain("100.00%");
    const none = waterfallTakeaway(
      waterfall([zeroRow({ headline_value: "100000000", minted: "100000000" })]),
    );
    expect(none).toContain("0.00%");
  });

  it("never says what the transfers were for", () => {
    const text = [
      waterfallTakeaway(waterfall(activity)),
      weeklyTakeaway(weeklyEveryday(activity)),
      velocityTakeaway(kpis),
    ].join(" ");
    expect(text).not.toMatch(/trading|commerce|payment|spend|purchase/i);
  });

  it("names the week, and says unknown with no complete week", () => {
    expect(weeklyTakeaway([])).toBe(UNKNOWN_TEXT);
    expect(weeklyTakeaway(weeklyEveryday(activity))).toContain("against");
    expect(weeklyTakeaway(weeklyEveryday(activity.filter((row) => row.day < "2026-10-04")))).toBe(
      UNKNOWN_TEXT,
    );
  });

  it("names the chain where velocity exceeds headline velocity", () => {
    expect(velocityTakeaway(kpis)).toContain("Base");
    expect(velocityTakeaway(kpis)).not.toContain("Ethereum");
  });

  it("says what each velocity divides, without claiming only the supplies differ", () => {
    const text = velocityTakeaway(kpis);
    expect(text).toContain("clean volume over circulating supply");
    expect(text).toContain("all transfers over total supply");
    expect(text).not.toContain("different supplies");
  });

  it("is unknown when no chain has both velocities", () => {
    expect(velocityTakeaway(kpis.map((row) => ({ ...row, headline_velocity_bps: null })))).toBe(
      UNKNOWN_TEXT,
    );
  });

  it("is unknown when no chain has a velocity", () => {
    expect(velocityTakeaway(kpis.map((row) => ({ ...row, velocity_bps: null })))).toBe(
      UNKNOWN_TEXT,
    );
  });

  it("takes the history length from the data", () => {
    const days = historyDays(activity);
    expect(historyLabel(activity)).toBe(`${days} days of history: a direction, not a trend`);
    expect(historyLabel(activity.filter((row) => row.day <= "2026-10-06"))).toBe(
      "7 days of history: a direction, not a trend",
    );
  });
});

describe("the short headings", () => {
  const partial: ActivityRow[] = JSON.parse(
    readFileSync(join(process.cwd(), "fixtures/dataset/partial/activity.json"), "utf8"),
  ).data;
  const words = (text: string) => text.split(/\s+/).length;
  const chains = activityChains(activity);
  const summed = (
    rows: ActivityRow[],
    field: "headline_value" | "clean_large" | "clean_everyday",
  ) =>
    rows
      .filter((row) => row.day >= "2026-09-30")
      .reduce((sum, row) => sum + BigInt(row[field]), 0n);

  it("the waterfall's reads its amounts and share from the rows, in at most 12 words", () => {
    const headline = summed(activity, "headline_value");
    const clean = summed(activity, "clean_large") + summed(activity, "clean_everyday");
    const text = waterfallHeading(waterfall(activity), chains);
    expect(text).toBe(
      `${formatCompact(clean)} of ${formatCompact(headline)} headline transfers is clean volume (${formatBps(Number((clean * 10_000n) / headline))}).`,
    );
    expect(words(text)).toBeLessThanOrEqual(12);
  });

  it("the weekly one reads the last two complete weeks, in at most 12 words", () => {
    const weeks = weeklyEveryday(activity);
    const sumWeek = (index: number) =>
      formatCompact(
        activity
          .filter((row) => row.day >= weeks[index].from && row.day <= weeks[index].to)
          .reduce((sum, row) => sum + BigInt(row.clean_everyday), 0n),
      );
    const text = weeklyHeading(weeks, chains);
    expect(text).toBe(
      `Everyday clean volume: ${sumWeek(weeks.length - 1)} over 7 days to ${shortDate(weeks.at(-1)!.to)}, ${sumWeek(weeks.length - 2)} before.`,
    );
    expect(words(text)).toBeLessThanOrEqual(12);
  });

  it("dates its block, which needn't reach the data's newest day", () => {
    const weeks = weeklyEveryday(activity);
    const newest = perChain(activity)
      .map((chain) => chain.to)
      .sort()
      .at(-1)!;
    expect(weeks.at(-1)!.to < newest).toBe(true);
    const text = weeklyHeading(weeks, chains);
    expect(text).toContain(`over 7 days to ${shortDate(weeks.at(-1)!.to)}`);
    expect(text).not.toMatch(/\blast\b|\bweek\b/i);
  });

  it("stays within 12 words at the widest figures and dates", () => {
    const week = { from: "2026-12-25", to: "2026-12-31", everyday: "999999000000000" };
    expect(words(weeklyHeading([week, week], chains))).toBeLessThanOrEqual(12);
  });

  it("one complete week has nothing before it", () => {
    const [week] = weeklyEveryday(activity);
    expect(weeklyHeading([week], chains)).toBe(
      `Everyday clean volume: ${formatCompact(week.everyday)} over 7 days to ${shortDate(week.to)}.`,
    );
  });

  it("both are unknown with nothing to say, never a zero", () => {
    expect(waterfallHeading(null, chains)).toBe(UNKNOWN_TEXT);
    expect(weeklyHeading([], chains)).toBe(UNKNOWN_TEXT);
  });

  it("zero clean volume reads as zero, and a zero week as $0", () => {
    const none = waterfall([zeroRow({ headline_value: "100000000", minted: "100000000" })]);
    expect(waterfallHeading(none, chains)).toBe(
      "$0 of $100 headline transfers is clean volume (0.00%).",
    );
    const week = { from: "2026-10-01", to: "2026-10-07", everyday: "0" };
    expect(weeklyHeading([week, week], chains)).toBe(
      "Everyday clean volume: $0 over 7 days to 7 Oct, $0 before.",
    );
  });

  it("both name their chains at partial scope, and never say all", () => {
    const scope = activityChains(partial);
    const texts = [
      waterfallHeading(waterfall(partial), scope),
      weeklyHeading(weeklyEveryday(partial), scope),
    ];
    for (const text of texts) {
      expect(text.startsWith("On Tempo and Ethereum, ")).toBe(true);
      expect(text).not.toMatch(/\ball\b/i);
      expect(words(text.replace("On Tempo and Ethereum, ", ""))).toBeLessThanOrEqual(12);
    }
    expect(texts[1]).toContain("everyday clean volume:");
  });

  it("name a single chain", () => {
    const one = activity.filter((row) => row.chain === "tempo");
    expect(waterfallHeading(waterfall(one), ["tempo"]).startsWith("On Tempo, ")).toBe(true);
    expect(weeklyHeading(weeklyEveryday(one), ["tempo"]).startsWith("On Tempo, everyday")).toBe(
      true,
    );
  });

  it("never say what the transfers were for", () => {
    const text = [
      waterfallHeading(waterfall(activity), chains),
      weeklyHeading(weeklyEveryday(activity), chains),
    ].join(" ");
    expect(text).not.toMatch(/trading|commerce|payment|spend|purchase/i);
  });

  it("the chains read from the rows, leaving out a chain with nothing from Day 0", () => {
    expect(chains).toEqual(["tempo", "ethereum", "base", "solana"]);
    expect(activityChains([zeroRow({ chain: "base", day: "2026-04-24" })])).toEqual([]);
  });
});

describe("weekly everyday volume", () => {
  it("counts only weeks every chain has reached, and sums exactly", () => {
    const weeks = weeklyEveryday(activity);
    expect(weeks).toHaveLength(4);
    expect(weeks[0].from).toBe("2026-09-30");
    expect(weeks[0].to).toBe("2026-10-06");
    const first = activity
      .filter((row) => row.day <= "2026-10-06")
      .reduce((sum, row) => sum + BigInt(row.clean_everyday), 0n);
    expect(BigInt(weeks[0].everyday)).toBe(first);
  });

  it("ignores pre-Day-0 rows in waterfall, perChain, historyDays and weeklyEveryday", () => {
    const preDayZero = zeroRow({
      day: "2026-04-24",
      headline_value: "999000000000000",
      clean_everyday: "999000000000000",
    });
    const withPre = [preDayZero, ...activity];
    expect(waterfall(withPre)).toEqual(waterfall(activity));
    expect(perChain(withPre)).toEqual(perChain(activity));
    expect(historyDays(withPre)).toBe(historyDays(activity));
    expect(weeklyEveryday(withPre)).toEqual(weeklyEveryday(activity));
  });

  it("gives each chain the whole's week boundaries, and the chains' weeks add up to the whole's", () => {
    const all = weeklyEveryday(activity);
    const chainsWeeks = (["tempo", "ethereum", "base", "solana"] as const).map((chain) =>
      weeklyEveryday(activity, [chain]),
    );
    for (const weeks of chainsWeeks) {
      expect(weeks.map(({ from, to }) => [from, to])).toEqual(
        all.map(({ from, to }) => [from, to]),
      );
    }
    all.forEach((week, index) => {
      const sum = chainsWeeks.reduce((total, weeks) => total + BigInt(weeks[index].everyday), 0n);
      expect(sum).toBe(BigInt(week.everyday));
    });
  });

  it("starts a late chain on the whole's first day, with nothing before it started", () => {
    // Solana's first row in the sample is 10 Oct, ten days after the others.
    const solana = weeklyEveryday(activity, ["solana"]);
    expect(solana[0].from).toBe("2026-09-30");
    expect(solana[0].everyday).toBe("0");
    expect(weeklyEveryday(activity.filter((row) => row.chain === "solana"))[0].from).toBe(
      "2026-10-10",
    );
  });

  it("doesn't let a chain a day behind make another chain's week look smaller", () => {
    // Base ends 2 Nov in the sample, a day before the others, so the block to 3 Nov isn't counted.
    const tempo = weeklyEveryday(activity, ["tempo"]);
    expect(tempo.at(-1)!.to).toBe(weeklyEveryday(activity).at(-1)!.to);
    const sum = activity
      .filter((row) => row.chain === "tempo")
      .filter((row) => row.day >= tempo.at(-1)!.from && row.day <= tempo.at(-1)!.to)
      .reduce((total, row) => total + BigInt(row.clean_everyday), 0n);
    expect(BigInt(tempo.at(-1)!.everyday)).toBe(sum);
  });

  it("has no weeks for a chain with no rows", () => {
    expect(
      weeklyEveryday(
        activity.filter((row) => row.chain !== "base"),
        ["base"],
      ),
    ).toEqual([]);
  });

  it("prints a removal that rounds to nothing as $0, with no sign", () => {
    expect(stepFigure({ kind: "removal", amount: "100000" })).toBe("$0");
    expect(stepFigure({ kind: "removal", amount: "21000000" })).toBe("−$21");
    expect(stepFigure({ kind: "clean", amount: "21000000" })).toBe("$21");
  });
});
