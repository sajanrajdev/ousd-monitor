import { NoteMarks, type PinnedNote } from "@/components/pinned-notes";
import { UNKNOWN_TEXT } from "@/lib/format";
import type { VelocityChart as Chart, VelocityMeasure } from "@/lib/chain-views";

// Pattern as well as colour tells the three measures apart, so colour is never alone.
const MEASURE_STYLE: Record<VelocityMeasure, { background: string; outlined?: boolean }> = {
  velocity_bps: { background: "var(--meaning-active)" },
  velocity_everyday_bps: {
    background:
      "repeating-linear-gradient(45deg, var(--meaning-circulating) 0 3px, var(--color-off-white) 3px 5px)",
    outlined: true,
  },
  headline_velocity_bps: { background: "var(--meaning-idle)", outlined: true },
};

export function measureStyle(measure: VelocityMeasure) {
  const { background, outlined } = MEASURE_STYLE[measure];
  return { background, ...(outlined ? { border: "1px solid var(--color-maroon)" } : {}) };
}

// Hand-built marks, so the chart is in the static HTML. Each bar has a direct label, on a linear scale
// from zero to the chart's largest figure. Each row names its measure, so there's no legend. A
// chain's note has its footnote marker on the chain's name, so the chart is read by assistive tech.
export function VelocityChart({
  chart,
  notes = [],
  footnotes = "",
}: {
  chart: Chart;
  notes?: PinnedNote[];
  footnotes?: string;
}) {
  if (chart.max === null) return <p className="p-4">{UNKNOWN_TEXT}</p>;
  return (
    <div data-flow className="velocity-chart" data-chart="velocity">
      {chart.groups.map((group) => (
        <div key={group.chain} className="velocity-chart__group" data-velocity-chain={group.chain}>
          <p className="velocity-chart__name">
            {group.name}
            <NoteMarks notes={notes} at={group.chain} prefix={footnotes} />
          </p>
          {group.bars.map((bar) => (
            <div key={bar.measure} className="velocity-chart__row" data-measure={bar.measure}>
              <span className="velocity-chart__label">{bar.label}</span>
              <span className="velocity-chart__track">
                {bar.widthBps !== null && bar.widthBps > 0 ? (
                  <span
                    className="velocity-chart__bar"
                    data-width={bar.widthBps}
                    style={{ width: `${bar.widthBps / 100}%`, ...measureStyle(bar.measure) }}
                  />
                ) : null}
              </span>
              <span className="velocity-chart__value" data-velocity-value>
                {bar.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
