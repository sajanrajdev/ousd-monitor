import { ChainPanels } from "@/components/chain-panels";
import { ChartCard } from "@/components/chart-card";
import { HairlineTable } from "@/components/hairline-table";
import type { PinnedNote } from "@/components/pinned-notes";
import { WaterfallChart, WeeklyBars, type StepPins } from "@/components/views/activity-charts";
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

const pinnedNote = ({ kind, text }: ActivityNote): PinnedNote => ({ kind, text });

// Each note's number on the row its pin sits on, by its place in the list, as PinnedNotes counts.
function stepPins(notes: ActivityNote[]): StepPins {
  return Object.fromEntries(
    notes.flatMap((note, index) => (note.step ? [[note.step, index + 1]] : [])),
  );
}

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
      notes={panel.notes.map(pinnedNote)}
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
      <WaterfallChart waterfall={panel.waterfall} pins={stepPins(panel.notes)} />
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
      <WeeklyBars weeks={panel.weeks} pins={panel.notes.map((_, index) => index + 1)} />
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
