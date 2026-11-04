import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActivityRow, KpiRow } from "@/lib/dataset";
import { UNKNOWN_TEXT } from "@/lib/format";
import {
  barPosition,
  historyDays,
  historyLabel,
  perChain,
  velocityTakeaway,
  waterfall,
  waterfallAmount,
  waterfallTakeaway,
  weeklyEveryday,
  weeklyTakeaway,
} from "@/lib/takeaways/activity";

const sample = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "fixtures/dataset/complete", name), "utf8"));
const activity: ActivityRow[] = sample("activity.json").data;
const kpis: KpiRow[] = sample("summary.json").kpis;

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
});
