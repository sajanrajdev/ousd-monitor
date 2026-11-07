// Shared Recharts settings. Colours are token references, so no hex lives in code.
export const SERIES_COLORS = ["var(--ramp-1)", "var(--ramp-2)", "var(--ramp-3)", "var(--ramp-4)"];

export const chartProps = {
  // The card's summary and table carry the content, so Recharts' keyboard layer stays off.
  accessibilityLayer: false,
} as const;

export const gridProps = {
  vertical: false,
  strokeDasharray: "1 4",
  stroke: "var(--color-border)",
} as const;

export const axisProps = {
  tickLine: false,
  axisLine: false,
  tick: { fill: "var(--color-meta-text)", fontSize: 12 },
  tickMargin: 8,
  minTickGap: 24,
} as const;

// Tooltips add detail and hold nothing essential.
export const tooltipProps = {
  isAnimationActive: false,
  contentStyle: {
    background: "var(--surface-card)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-control)",
    fontSize: "var(--text-small)",
  },
} as const;

export const seriesProps = { isAnimationActive: false } as const;

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

// 600000000 -> "$600M"
export function formatCompactUsd(value: number): string {
  return `${value < 0 ? "\u2212" : ""}$${COMPACT.format(Math.abs(value))}`;
}

const UTC_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

const UTC_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// "4 Nov 2026 UTC". Returns the input unchanged when it isn't a date.
export function formatUtcDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${UTC_DATE.format(date)} UTC`;
}

// "4 Nov 2026, 14:05 UTC"
export function formatUtcDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${UTC_DATE_TIME.format(date)} UTC`;
}
