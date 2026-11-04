import { ChartCard } from "@/components/chart-card";
import { dayRange, newestByChain } from "@/lib/aggregate";
import type { ActivityRow, Definitions, DatasetState, KpiRow } from "@/lib/dataset";
import { CHAIN_NAMES, DAY_ZERO, definitionHref } from "@/lib/definitions";
import { formatUtcDate, UNKNOWN_TEXT } from "@/lib/format";

export type ActivityViewProps = {
  activity: ActivityRow[];
  kpis: KpiRow[];
  definitions: Definitions;
  state: DatasetState;
};

// A stub until unit 3.3b.
export function ActivityView({ activity, state }: ActivityViewProps) {
  const newest = newestByChain(activity);
  return (
    <section id="real-activity" data-section="view-b">
      <ChartCard
        takeaway={UNKNOWN_TEXT}
        chip="inferred"
        source="Chain data and public labels"
        asOf={dayRange(newest.map((row) => row.day)) ?? DAY_ZERO}
        definitionHref={definitionHref("clean-volume")}
        frameWord={state.frameWord}
        summary={UNKNOWN_TEXT}
        table={{
          caption: "Newest day per chain",
          columns: [
            { key: "chain", label: "Chain" },
            { key: "day", label: "Day" },
          ],
          rows: newest.map((row) => ({
            chain: CHAIN_NAMES[row.chain],
            day: formatUtcDate(row.day),
          })),
        }}
      >
        {null}
      </ChartCard>
    </section>
  );
}
