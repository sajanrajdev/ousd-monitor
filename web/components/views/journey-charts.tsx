"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  axisProps,
  chartProps,
  formatCompactUsd,
  formatUtcDate,
  gridProps,
  seriesProps,
  tooltipProps,
} from "@/components/chart-theme";
import { floorBps, JOURNEY_PARTS } from "@/lib/aggregate";
import type { JourneyRow } from "@/lib/dataset/rows";
import { formatBps, formatCompact, toChartNumber, UNKNOWN_TEXT } from "@/lib/format";

// A segment under this share of its bar has no room for a label, so the list below the bar names it.
const LABEL_MIN_BPS = 2500;

type Part = (typeof JOURNEY_PARTS)[number];

// Meaning colours, plus a pattern where the design system asks for one, so colour is never alone.
// Only marks in ramp steps 3 and 4 (removed, idle) get the maroon hairline outline the design
// system asks for. The other segments differ from their neighbours by colour and are left bare.
const HATCH =
  "repeating-linear-gradient(45deg, transparent 0 4px, color-mix(in srgb, var(--color-maroon-dark) 45%, transparent) 4px 6px)";
const DOTS =
  "radial-gradient(color-mix(in srgb, var(--color-off-white) 70%, transparent) 1.5px, transparent 1.6px) 0 0 / 8px 8px";

export const PART_STYLES: Record<
  Part,
  { label: string; background: string; image?: string; color: string; outlined?: boolean }
> = {
  issuer_inventory: {
    label: "Issuer inventory",
    background: "var(--meaning-removed)",
    image: HATCH,
    color: "var(--color-maroon-dark)",
    outlined: true,
  },
  placed_supply: {
    label: "Placed",
    background: "var(--meaning-idle)",
    color: "var(--color-maroon-dark)",
    outlined: true,
  },
  venue_dex: {
    label: "DEX venues",
    background: "var(--meaning-circulating)",
    color: "var(--color-off-white)",
  },
  venue_lending: {
    label: "Lending venues",
    background: "var(--meaning-circulating)",
    image: HATCH,
    color: "var(--color-off-white)",
  },
  venue_exchange: {
    label: "Exchange venues",
    background: "var(--meaning-circulating)",
    image: DOTS,
    color: "var(--color-off-white)",
  },
  free_floating: {
    label: "Free-floating",
    background: "var(--meaning-active)",
    color: "var(--color-off-white)",
  },
};

export type BarRow = {
  key: string;
  name: string;
  // The day this row is from, or a range label when it spans several.
  day: string;
  journey: Pick<JourneyRow, Part | "total_supply">;
  // From activity, because journey has no circulating figure.
  circulating: string | null;
};

function bpsOf(part: string, total: bigint): number {
  return total > 0n ? (floorBps(BigInt(part), total) ?? 0) : 0;
}

function Bar({ row }: { row: BarRow }) {
  const total = BigInt(row.journey.total_supply);
  if (total === 0n) {
    return (
      <div>
        <p className="font-semibold">
          {row.name}{" "}
          <span className="text-[length:var(--text-meta)] text-[color:var(--color-meta-text)]">
            · {row.day}
          </span>
        </p>
        <p className="text-[length:var(--text-meta)] text-[color:var(--color-meta-text)]">
          {UNKNOWN_TEXT}: this chain has no supply on this day.
        </p>
      </div>
    );
  }
  const parts = JOURNEY_PARTS.map((part) => ({
    part,
    bps: bpsOf(row.journey[part], total),
    amount: row.journey[part],
  }));
  // The bracket starts where the drawn issuer and placed segments end.
  const circulatingStart = parts[0].bps + parts[1].bps;
  const small = parts.filter((p) => p.bps < LABEL_MIN_BPS && BigInt(p.amount) > 0n);
  return (
    <div>
      <p className="font-semibold">
        {row.name}{" "}
        <span className="text-[length:var(--text-meta)] text-[color:var(--color-meta-text)]">
          · {row.day}
        </span>
      </p>
      <div className="mt-1 flex min-h-10 w-full overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-border)]">
        {parts
          .filter((p) => BigInt(p.amount) > 0n)
          .map(({ part, bps, amount }) => {
            const style = PART_STYLES[part];
            return (
              <div
                key={part}
                data-part={part}
                title={`${style.label}: ${formatCompact(amount)}`}
                className="min-w-px overflow-hidden px-1 text-[length:var(--text-meta)] leading-tight break-words"
                style={{
                  flexBasis: `${bps / 100}%`,
                  flexGrow: 0,
                  flexShrink: 0,
                  background: style.image
                    ? `${style.image}, ${style.background}`
                    : style.background,
                  color: style.color,
                  ...(style.outlined ? { border: "1px solid var(--color-maroon)" } : {}),
                }}
              >
                {bps >= LABEL_MIN_BPS ? `${style.label} ${formatBps(bps)}` : null}
              </div>
            );
          })}
      </div>
      <div className="relative mt-1 h-1 w-full" aria-hidden="true">
        <div
          className="absolute top-0 h-full border-t-2 border-x-2 border-[var(--meaning-circulating)]"
          style={{ left: `${circulatingStart / 100}%`, right: 0 }}
        />
      </div>
      <p className="text-[length:var(--text-meta)] text-[color:var(--color-meta-text)] text-right">
        Circulating, from activity data: {formatCompact(row.circulating)}
      </p>
      {small.length > 0 ? (
        <ul
          className="text-[length:var(--text-meta)] text-[color:var(--color-meta-text)] mt-1"
          data-testid="small-segments"
        >
          {small.map(({ part, bps, amount }) => (
            <li key={part}>
              {PART_STYLES[part].label}: {formatCompact(amount)} ({formatBps(bps)})
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SupplyBars({ rows }: { rows: BarRow[] }) {
  return (
    <div className="flex flex-col gap-4 bg-[var(--surface-card)] p-3" data-chart="supply-bars">
      {/* One row per chain doesn't fit the card's fixed chart height, so this chart grows to its rows. */}
      <style href="journey-bars" precedence="default">
        {'.chart-area:has([data-chart="supply-bars"]) { height: auto; }'}
      </style>
      {rows.map((row) => (
        <Bar key={row.key} row={row} />
      ))}
    </div>
  );
}

export function BarLegend() {
  return (
    <ul
      className="text-[length:var(--text-meta)] text-[color:var(--color-meta-text)] mt-3 flex flex-wrap gap-x-4 gap-y-1"
      data-testid="bar-legend"
    >
      {JOURNEY_PARTS.map((part) => (
        <li key={part} className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 border border-[var(--color-border)]"
            data-outlined={PART_STYLES[part].outlined ? "" : undefined}
            style={{
              ...(PART_STYLES[part].outlined ? { borderColor: "var(--color-maroon)" } : {}),
              background: PART_STYLES[part].image
                ? `${PART_STYLES[part].image}, ${PART_STYLES[part].background}`
                : PART_STYLES[part].background,
            }}
          />
          {PART_STYLES[part].label}
        </li>
      ))}
    </ul>
  );
}

export type SeriesDatum = {
  day: string;
  total_supply: string;
  placed_supply: string;
  circulating_supply: string;
};

const LINES = [
  {
    key: "total_supply",
    label: "Total",
    stroke: "var(--meaning-active)",
    dash: undefined,
    width: 2,
  },
  {
    key: "circulating_supply",
    label: "Circulating",
    stroke: "var(--meaning-circulating)",
    dash: "6 3",
    width: 2,
  },
  { key: "placed_supply", label: "Placed", stroke: "var(--meaning-idle)", dash: "2 3", width: 4 },
] as const;

// Step lines, all chains. Recharts draws floats; every label comes from the exact string.
export function SupplySeries({ series }: { series: SeriesDatum[] }) {
  if (series.length === 0) return <p className="p-4">{UNKNOWN_TEXT}</p>;
  const data = series.map((point) => ({
    day: point.day,
    total_supply: toChartNumber(point.total_supply),
    placed_supply: toChartNumber(point.placed_supply),
    circulating_supply: toChartNumber(point.circulating_supply),
  }));
  return (
    <div className="flex h-full flex-col">
      <ul
        className="text-[length:var(--text-meta)] text-[color:var(--color-meta-text)] flex flex-wrap gap-x-4"
        data-testid="series-legend"
      >
        {LINES.map((line) => (
          <li key={line.key} className="flex items-center gap-1">
            <svg width="24" height="8" aria-hidden="true">
              <line
                x1="0"
                x2="24"
                y1="4"
                y2="4"
                stroke={line.stroke}
                strokeWidth={line.width}
                strokeDasharray={line.dash}
              />
            </svg>
            {line.label}
          </li>
        ))}
      </ul>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} {...chartProps} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis
              dataKey="day"
              {...axisProps}
              tickFormatter={(day: string) => formatUtcDate(day).replace(/ UTC$/, "")}
            />
            <YAxis
              {...axisProps}
              width={56}
              tickFormatter={(value: number) => formatCompactUsd(value)}
            />
            <Tooltip
              {...tooltipProps}
              labelFormatter={(day) => formatUtcDate(String(day))}
              formatter={(value) => formatCompactUsd(Number(value))}
            />
            {LINES.map((line) => (
              <Line
                key={line.key}
                type="stepAfter"
                dataKey={line.key}
                name={line.label}
                stroke={line.stroke}
                strokeWidth={line.width}
                strokeDasharray={line.dash}
                dot={false}
                {...seriesProps}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
