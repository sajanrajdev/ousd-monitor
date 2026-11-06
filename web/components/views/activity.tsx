import { ChainPanels } from "@/components/chain-panels";
import { ChartCard } from "@/components/chart-card";
import { HairlineTable } from "@/components/hairline-table";
import type { PinnedNote } from "@/components/pinned-notes";
import { WaterfallChart, WeeklyBars } from "@/components/views/activity-charts";
import {
  PERIOD_COLUMNS,
  scopeWords,
  STEP_COLUMNS,
  waterfallPanel,
  WEEK_COLUMNS,
  weeklyPanel,
  type ActivityNote,
  type WaterfallPanel,
  type WeeklyPanel,
} from "@/lib/activity-panels";
import type { ChainOption } from "@/lib/chain-scope";
import type { ActivityRow, Definitions, DatasetState, KpiRow } from "@/lib/dataset";
import { CARD_ANCHORS, definitionHref } from "@/lib/definitions";

export type ActivityViewProps = {
  options: ChainOption[];
  activity: ActivityRow[];
  kpis: KpiRow[];
  definitions: Definitions;
  state: DatasetState;
};

const SOURCE = "Chain data and public labels";

// A note on a waterfall row has its badge on that row's label.
const pinnedNote = ({ kind, text, step }: ActivityNote): PinnedNote => ({ kind, text, at: step });

// The notes in full, for the tooltip. Nothing here is the only copy of a caveat.
function FullNotes({ notes }: { notes: Record<string, string> }) {
  return (
    <>
      {Object.entries(notes).map(([kind, text]) => (
        <p key={kind} data-full-note={kind}>
          {text}
        </p>
      ))}
    </>
  );
}

function WaterfallCard({ panel, state }: { panel: WaterfallPanel; state: DatasetState }) {
  const scope = scopeWords(panel.chains);
  const notes = panel.notes.map(pinnedNote);
  return (
    <ChartCard
      takeaway={panel.heading}
      detail={
        <>
          <p>{panel.takeaway}</p>
          <FullNotes notes={panel.fullNotes} />
        </>
      }
      source={SOURCE}
      asOf={panel.asOf}
      definitionHref={definitionHref("clean-volume")}
      frameWord={state.frameWord}
      summary={panel.summary}
      notes={notes}
      plotIsContent
      table={{
        caption: `From headline volume to clean volume, ${scope}, Day 0 through each chain's newest day`,
        columns: STEP_COLUMNS,
        rows: panel.steps.rows,
      }}
      moreTables={
        <HairlineTable
          caption={`Period covered per chain, ${scope}, Day 0 through each chain's newest day`}
          columns={PERIOD_COLUMNS}
          rows={panel.periods.rows}
        />
      }
    >
      <WaterfallChart waterfall={panel.waterfall} notes={notes} />
    </ChartCard>
  );
}

function WeeklyCard({ panel, state }: { panel: WeeklyPanel; state: DatasetState }) {
  return (
    <ChartCard
      takeaway={panel.heading}
      detail={
        <>
          <p>{panel.takeaway}</p>
          <FullNotes notes={panel.fullNotes} />
        </>
      }
      source={SOURCE}
      asOf={panel.asOf}
      definitionHref={definitionHref("everyday-large")}
      frameWord={state.frameWord}
      summary={panel.summary}
      notes={panel.notes.map(pinnedNote)}
      table={{
        caption: `Clean everyday volume per complete week, ${scopeWords(panel.chains)}`,
        columns: WEEK_COLUMNS,
        rows: panel.table.rows,
      }}
    >
      <WeeklyBars weeks={panel.weeks} />
    </ChartCard>
  );
}

export function ActivityView({ options, activity, kpis, definitions, state }: ActivityViewProps) {
  const inputs = { activity, kpis, definitions };

  return (
    <section id="real-activity" data-section="view-b" className="card-grid">
      <ChainPanels options={options} id={CARD_ANCHORS.waterfall}>
        {(option) => <WaterfallCard panel={waterfallPanel(option, inputs)} state={state} />}
      </ChainPanels>
      <ChainPanels options={options} id={CARD_ANCHORS.weekly}>
        {(option) => <WeeklyCard panel={weeklyPanel(option, inputs)} state={state} />}
      </ChainPanels>
    </section>
  );
}
