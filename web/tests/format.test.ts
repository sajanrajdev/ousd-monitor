import { describe, expect, it } from "vitest";
import {
  formatAsOf,
  formatBaseUnits,
  formatBps,
  formatCompact,
  formatExact,
  toChartNumber,
  UNKNOWN_TEXT,
} from "@/lib/format";

const dollars = (value: string) => `${value}000000`;

describe("amounts", () => {
  it("prints 2^53 + 1 base units exactly", () => {
    expect(formatExact(String(2n ** 53n + 1n))).toBe("$9,007,199,254.740993");
    expect(formatBaseUnits(String(2n ** 53n + 1n))).toBe("9,007,199,254,740,993");
  });

  it("drops an all-zero fraction, and trims the rest", () => {
    expect(formatExact(dollars("600000000"))).toBe("$600,000,000");
    expect(formatExact("1500000")).toBe("$1.5");
  });

  it("is compact, with half-up rounding at .05 boundaries", () => {
    expect(formatCompact(dollars("605500000"))).toBe("$605.5M");
    expect(formatCompact(dollars("1050000"))).toBe("$1.1M");
    expect(formatCompact(dollars("1049999"))).toBe("$1M");
    expect(formatCompact(dollars("1250"))).toBe("$1.3K");
    expect(formatCompact(dollars("12050000000"))).toBe("$12.1B");
  });

  it("rounds once, from the exact amount", () => {
    expect(formatCompact("1449999600000")).toBe("$1.4M");
    expect(formatCompact("1450000000000")).toBe("$1.5M");
    expect(formatCompact("1449999600")).toBe("$1.4K");
    expect(formatCompact("1449999999600000")).toBe("$1.4B");
    expect(formatCompact("999400000")).toBe("$999");
    expect(formatCompact("999600000")).toBe("$1K");
  });

  it("gives way to the next unit rather than printing 1000", () => {
    expect(formatCompact(dollars("999960"))).toBe("$1M");
    expect(formatCompact(dollars("999960000"))).toBe("$1B");
    expect(formatCompact(dollars("999"))).toBe("$999");
  });

  it("rounds a sub-dollar amount half up", () => {
    expect(formatCompact("1500000")).toBe("$2");
    expect(formatCompact("1499999")).toBe("$1");
  });

  it("prints zero as $0", () => {
    expect(formatCompact("0")).toBe("$0");
    expect(formatExact("0")).toBe("$0");
  });

  it("prints null as the unknown text, never 0", () => {
    for (const format of [formatCompact, formatExact, formatBaseUnits]) {
      expect(format(null)).toBe(UNKNOWN_TEXT);
    }
    expect(UNKNOWN_TEXT).toBe("Not enough data yet");
  });

  it("gives negative amounts a sign", () => {
    expect(formatCompact(`-${dollars("5000000")}`)).toBe("−$5M");
    expect(formatExact("-1500000")).toBe("−$1.5");
    expect(formatBaseUnits("-1000")).toBe("−1,000");
  });
});

describe("a negative amount that rounds to nothing", () => {
  it("has no sign", () => {
    expect(formatCompact("-400000")).toBe("$0");
    expect(formatCompact("-500000")).toBe("\u2212$1");
  });
});

describe("basis points", () => {
  it("prints as a percent", () => {
    expect(formatBps(7374)).toBe("73.74%");
    expect(formatBps(5)).toBe("0.05%");
    expect(formatBps(0)).toBe("0.00%");
    expect(formatBps(-125)).toBe("−1.25%");
  });

  it("prints null as the unknown text", () => {
    expect(formatBps(null)).toBe(UNKNOWN_TEXT);
  });
});

describe("dates", () => {
  it("labels days and times as UTC", () => {
    expect(formatAsOf("2026-11-03")).toBe("3 Nov 2026 UTC");
    expect(formatAsOf("2026-11-04T05:30:00Z")).toBe("4 Nov 2026, 05:30 UTC");
  });

  it("names a range only when days differ", () => {
    expect(formatAsOf({ from: "2026-11-02", to: "2026-11-03" })).toBe(
      "2 Nov 2026 to 3 Nov 2026 UTC",
    );
    expect(formatAsOf({ from: "2026-11-03", to: "2026-11-03" })).toBe("3 Nov 2026 UTC");
  });
});

describe("toChartNumber", () => {
  it("is the one float, and keeps null", () => {
    expect(toChartNumber("1500000")).toBe(1.5);
    expect(toChartNumber(null)).toBeNull();
  });
});
