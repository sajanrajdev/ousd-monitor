"use client";

import { useSyncExternalStore } from "react";
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
import { PinMark } from "@/components/pinned-notes";
import { formatCompact, toChartNumber, UNKNOWN_TEXT } from "@/lib/format";
import {
  directLabel,
  legendAmount,
  segmentLabel,
  type BarRow,
  type DrawnSegment,
  type SeriesPoint,
} from "@/lib/supply-segments";

const widthOf = (bps: number | null) => `${(bps ?? 0) / 100}%`;

// One bar, drawn from the segments, so a segment in the config needs no markup here. `row` is what
// verify-output holds this bar's band to, in the page's serialized copy.
export function SupplyBar({
  row,
  segments,
  pins,
}: {
  row: BarRow;
  segments: DrawnSegment[];
  pins: Record<string, number>;
}) {
  if (BigInt(row.journey.total_supply) === 0n) {
    return <p data-chart="supply-bar">{UNKNOWN_TEXT}: this chain has no supply on this day.</p>;
  }
  const drawn = segments.filter((segment) => BigInt(segment.amount) > 0n);
  // The bracket starts where the drawn segments it doesn't cover end.
  const circulatingStart = segments
    .filter((segment) => !segment.circulating)
    .reduce((sum, segment) => sum + (segment.shareBps ?? 0), 0);
  const hasCirculating = segments.some(
    (segment) => segment.circulating && BigInt(segment.amount) > 0n,
  );
  return (
    <div
      className="supply-bar"
      data-chart="supply-bar"
      data-supply-bar={row.key}
      data-total={row.journey.total_supply}
    >
      <div className="supply-bar__track">
        {drawn.map((segment) => {
          const { style } = segment;
          const label = directLabel(segment);
          return (
            <div
              key={segment.key}
              className="supply-bar__part"
              data-part={segment.key}
              data-amount={segment.amount}
              title={`${segmentLabel(segment)}: ${legendAmount(segment)}`}
              style={{
                flexBasis: widthOf(segment.shareBps),
                background: style.image ? `${style.image}, ${style.background}` : style.background,
                color: style.color,
                ...(style.outlined ? { border: "1px solid var(--color-maroon)" } : {}),
              }}
            >
              {label ? (
                <span
                  data-testid="part-label"
                  className="supply-bar__label z-10"
                  style={{ background: style.background }}
                >
                  <span data-direct-label>{label}</span>
                  {pins[segment.key] ? <PinMark number={pins[segment.key]} /> : null}
                </span>
              ) : null}
              {segment.band && BigInt(segment.band.amount) > 0n ? (
                <span
                  aria-hidden="true"
                  data-testid="exchange-linked-band"
                  className="supply-bar__band"
                  style={{
                    width: widthOf(segment.band.shareOfSegmentBps),
                    background: segment.band.background,
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {hasCirculating ? (
        <div className="supply-bar__bracket">
          <div style={{ marginLeft: widthOf(circulatingStart) }} />
          <span>Circulating</span>
        </div>
      ) : null}
    </div>
  );
}

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

// Beside the chart, with each line's newest figure. Every one of them is in the table.
export function SeriesLegend({ latest }: { latest: SeriesPoint }) {
  return (
    <ul className="chart-legend" data-testid="series-legend" data-series-legend>
      {LINES.map((line) => (
        <li key={line.key} className="chart-legend__row" data-series-line={line.key}>
          <svg className="chart-legend__line" width="24" height="8" aria-hidden="true">
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
          <span className="chart-legend__label">{line.label}</span>
          <span className="chart-legend__values" data-series-value>
            {formatCompact(latest[line.key])}
          </span>
        </li>
      ))}
    </ul>
  );
}

const filterInput = () =>
  document.querySelector<HTMLInputElement>(".chain-filter input:checked")?.value ?? "all";

function subscribeToFilter(onChange: () => void) {
  document.addEventListener("change", onChange);
  return () => document.removeEventListener("change", onChange);
}

// Only the selected panel mounts Recharts. Where there's no :has(), every panel shows, so all draw.
function usePanelShown(panel: string): boolean {
  return useSyncExternalStore(
    subscribeToFilter,
    () => filterInput() === panel || globalThis.CSS?.supports?.("selector(:has(*))") === false,
    () => false,
  );
}

// Step lines, for one filter option. Recharts draws floats; every label comes from the exact string.
export function SupplySeries({ series, panel }: { series: SeriesPoint[]; panel: string }) {
  const shown = usePanelShown(panel);
  if (series.length === 0) return <p className="p-4">{UNKNOWN_TEXT}</p>;
  if (!shown) return null;
  const data = series.map((point) => ({
    day: point.day,
    total_supply: toChartNumber(point.total_supply),
    placed_supply: toChartNumber(point.placed_supply),
    circulating_supply: toChartNumber(point.circulating_supply),
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} {...chartProps} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid {...gridProps} />
        <XAxis
          dataKey="day"
          {...axisProps}
          minTickGap={64}
          tickFormatter={(day: string) => formatUtcDate(day).replace(/ \d{4} UTC$/, "")}
        />
        <YAxis
          {...axisProps}
          width={56}
          tickCount={3}
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
  );
}
