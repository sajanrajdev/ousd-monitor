import {
  barPosition,
  type Waterfall,
  type WaterfallStep,
  type Week,
} from "@/lib/takeaways/activity";
import { formatCompact, formatUtcDate, toChartNumber, UNKNOWN_TEXT } from "@/lib/format";

// The card reserves a fixed chart height, and twelve rows are taller than that on a phone. A chart
// that sets data-flow lets its area grow to fit, so the rows never spill over the note below.
function GrowArea() {
  return <style>{".chart-area:has([data-flow]) { height: auto; }"}</style>;
}

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
export function WaterfallChart({ waterfall }: { waterfall: Waterfall | null }) {
  if (!waterfall) return <p className="p-4">{UNKNOWN_TEXT}</p>;
  return (
    <>
      <GrowArea />
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
                <span>{step.label}</span>
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

export function WeeklyBars({ weeks, history }: { weeks: Week[]; history: string }) {
  if (weeks.length === 0) return <p className="p-4">{UNKNOWN_TEXT}</p>;
  const values = weeks.map((week) => toChartNumber(week.everyday) ?? 0);
  const max = Math.max(...values, 1);
  return (
    <figure className="m-0 p-4">
      <div className="flex items-end gap-2" style={{ height: "10rem" }}>
        {weeks.map((week, index) => (
          <div key={week.from} className="flex h-full min-w-0 flex-1 flex-col justify-end">
            <span className="text-center tabular-nums" style={{ fontSize: "var(--text-meta)" }}>
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
      <figcaption className="mt-2" style={{ fontSize: "var(--text-meta)" }}>
        Weeks end on the date shown, in UTC. {history}.
      </figcaption>
    </figure>
  );
}
