import type { DatasetState, KpiRow as KpiRowData } from "@/lib/dataset";
import { allChainKpis } from "@/lib/aggregate";
import { formatAsOf, UNKNOWN_TEXT } from "@/lib/format";

export type KpiRowProps = {
  kpis: KpiRowData[];
  state: DatasetState;
};

// A stub until unit 3.2. The frame word stays, so a crop of this row still reads as not real.
export function KpiRow({ kpis, state }: KpiRowProps) {
  const figures = allChainKpis(kpis);
  return (
    <section className="kpi-row" aria-label="Key figures" data-section="kpi-row">
      <p>{UNKNOWN_TEXT}</p>
      <p className="chart-card__meta">
        {figures ? `As of ${formatAsOf(figures.asOf)}` : UNKNOWN_TEXT}
        {state.frameWord ? (
          <>
            {" "}
            · <strong data-frame-word>{state.frameWord}</strong>
          </>
        ) : null}
      </p>
    </section>
  );
}
