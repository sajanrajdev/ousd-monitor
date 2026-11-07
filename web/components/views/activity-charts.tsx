import {
  barPosition,
  stepFigure,
  type Waterfall,
  type WaterfallStep,
  type Week,
} from "@/lib/takeaways/activity";
import { NoteMarks, type PinnedNote } from "@/components/pinned-notes";
import { formatCompact, formatUtcDate, toChartNumber, UNKNOWN_TEXT } from "@/lib/format";

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
// chart that sets data-flow lets its area grow to fit (in globals.css). A row's note has its
// footnote marker at the end of the row's label, so the chart is read by assistive tech, as a list.
export function WaterfallChart({
  waterfall,
  notes = [],
  footnotes = "",
}: {
  waterfall: Waterfall | null;
  notes?: PinnedNote[];
  footnotes?: string;
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
                  <NoteMarks notes={notes} at={step.key} prefix={footnotes} />
                </span>
                <span className="tabular-nums" style={{ fontWeight: 550 }}>
                  {stepFigure(step)}
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

// A narrow panel's figure may break before its unit, "$516.1" then "K", and never inside the number.
function WeekFigure({ amount }: { amount: string }) {
  const [, number, unit] = /^(.*?)([KMB]?)$/.exec(formatCompact(amount))!;
  return (
    <>
      <span className="whitespace-nowrap" data-week-number>
        {number}
      </span>
      {unit ? (
        <>
          <wbr />
          {unit}
        </>
      ) : null}
    </>
  );
}

// Bars scale to the panel's own largest week.
export function WeeklyBars({ weeks }: { weeks: Week[] }) {
  if (weeks.length === 0) return <p className="p-4">{UNKNOWN_TEXT}</p>;
  const values = weeks.map((week) => toChartNumber(week.everyday) ?? 0);
  const max = Math.max(...values, 1);
  return (
    <>
      <figure data-flow className="m-0 p-4">
        <div className="flex items-end gap-1" style={{ height: "10rem" }}>
          {weeks.map((week, index) => (
            <div
              key={week.from}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
              data-week={week.to}
            >
              <span
                className="text-center tabular-nums"
                style={{ fontSize: "var(--text-meta)" }}
                data-week-value
              >
                <WeekFigure amount={week.everyday} />
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
        <div className="mt-1 flex gap-1" style={{ fontSize: "var(--text-meta)" }}>
          {weeks.map((week) => (
            <span key={week.from} className="min-w-0 flex-1 text-center">
              {formatUtcDate(week.to).replace(/ \d{4} UTC$/, "")}
            </span>
          ))}
        </div>
      </figure>
    </>
  );
}
