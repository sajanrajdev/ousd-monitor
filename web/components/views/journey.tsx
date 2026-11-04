import { ChartCard } from "@/components/chart-card";
import { dayRange, newestByChain } from "@/lib/aggregate";
import type { ActivityRow, Definitions, DatasetState, JourneyRow, KpiRow } from "@/lib/dataset";
import { CHAIN_NAMES, definitionHref } from "@/lib/definitions";
import { formatUtcDate, UNKNOWN_TEXT } from "@/lib/format";

export type JourneyViewProps = {
  journey: JourneyRow[];
  activity: ActivityRow[];
  kpis: KpiRow[];
  definitions: Definitions;
  state: DatasetState;
};

// A stub until unit 3.3a.
export function JourneyView({ journey, definitions, state }: JourneyViewProps) {
  const newest = newestByChain(journey);
  return (
    <section id="supply-journey" data-section="view-a">
      <ChartCard
        takeaway={UNKNOWN_TEXT}
        chip="inferred"
        source="Chain data and public labels"
        asOf={dayRange(newest.map((row) => row.day)) ?? definitions.journey_first_day}
        definitionHref={definitionHref("placed-supply")}
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
