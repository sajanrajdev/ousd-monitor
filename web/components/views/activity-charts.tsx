import {
  barPosition,
  type Waterfall,
  type WaterfallStep,
  type Week,
} from "@/lib/takeaways/activity";
import { PinMark } from "@/components/pinned-notes";
import { formatCompact, formatUtcDate, toChartNumber, UNKNOWN_TEXT } from "@/lib/format";

// A pin's number by the waterfall row it sits on, or for the weekly bars, in note order. The card
// works these out from its notes, so a pin can't point at another note.
export type StepPins = Partial<Record<WaterfallStep["key"], number>>;

// Hatching as well as colour marks what was taken out of headline.
const HATCH =
  "repeating-linear-gradient(45deg, var(--meaning-removed) 0 3px, var(--color-off-white) 3px 6px)";

function barStyle(kind: WaterfallStep["kind"], left: number, width: number) {
  const base = { left: `${left / 100}%`, width: `${width / 100}%`, minWidth: width > 0 ? 3 : 0 };
  if (kind === "removal") {
    return { ...base, background: HATCH, outline: "1px solid var(--color-maroon)" };
  }
  return {
    ...base,
    background: kind === "clean" ? "var(--meaning-active)" : "var(--meaning-circulating)",
  };
}

// One row per step at every width: label and value on the left, bar on the right, so a sliver of a
// bar still has a readable label. The card's table carries the same numbers for assistive tech.
// The card reserves a fixed chart height, and twelve rows are taller than that on a phone, so a
// chart that sets data-flow lets its area grow to fit (in globals.css).
export function WaterfallChart({
  waterfall,
  pins = {},
}: {
  waterfall: Waterfall | null;
  pins?: StepPins;
}) {
  if (!waterfall) return <p className="p-4">{UNKNOWN_TEXT}</p>;
  return (
    <>
      <ol data-flow className="m-0 list-none p-4" style={{ fontSize: "var(--text-small)" }}>
        {waterfall.steps.map((step) => {
          const { left, width } = barPosition(step, waterfall.headline);
          return (
            <li
              key={step.key}
              data-step={step.key}
              className="grid items-center gap-3 py-1"
              style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}
            >
              <span className="flex flex-wrap justify-between gap-x-2">
                <span>
                  {step.label}
                  {pins[step.key] ? (
                    <span className="ml-1 inline-block align-middle">
                      <PinMark number={pins[step.key]!} />
                    </span>
                  ) : null}
                </span>
                <span className="tabular-nums" style={{ fontWeight: 550 }}>
                  {step.kind === "removal" ? "−" : ""}
                  {formatCompact(step.amount)}
                </span>
              </span>
              <span className="relative block h-4" style={{ background: "var(--color-secondary)" }}>
                <span
                  data-bar
                  className="absolute top-0 block h-full"
                  style={barStyle(step.kind, left, width)}
                />
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// Bars scale to the panel's own largest week. Its pins sit in the corner, for notes about every bar.
export function WeeklyBars({ weeks, pins = [] }: { weeks: Week[]; pins?: number[] }) {
  if (weeks.length === 0) return <p className="p-4">{UNKNOWN_TEXT}</p>;
  const values = weeks.map((week) => toChartNumber(week.everyday) ?? 0);
  const max = Math.max(...values, 1);
  return (
    <>
      <figure data-flow className="m-0 p-4">
        {pins.length > 0 ? (
          <div className="mb-1 flex gap-1" data-chart-pins>
            {pins.map((number) => (
              <PinMark key={number} number={number} />
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-2" style={{ height: "10rem" }}>
          {weeks.map((week, index) => (
            <div
              key={week.from}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
              data-week={week.to}
            >
              <span
                className="text-center tabular-nums"
                // A narrow panel's figure wraps inside its own column, not over its neighbour's.
                style={{ fontSize: "var(--text-meta)", overflowWrap: "anywhere" }}
                data-week-value
              >
                {formatCompact(week.everyday)}
              </span>
              <span
                className="block w-full"
                style={{
                  height: `${Math.max((values[index] / max) * 100, values[index] > 0 ? 1 : 0)}%`,
                  background: "var(--meaning-active)",
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex gap-2" style={{ fontSize: "var(--text-meta)" }}>
          {weeks.map((week) => (
            <span key={week.from} className="min-w-0 flex-1 text-center">
              {formatUtcDate(week.to).replace(/ UTC$/, "")}
            </span>
          ))}
        </div>
      </figure>
    </>
  );
}
