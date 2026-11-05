import { ChainPanels } from "@/components/chain-panels";
import { ChartCard, TableCard } from "@/components/chart-card";
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
import { dayRange, newestByChain } from "@/lib/aggregate";
import type { ChainOption } from "@/lib/chain-scope";
import type {
  ActivityRow,
  Definitions,
  DatasetState,
  KpiRow,
  ManifestWarning,
} from "@/lib/dataset";
import { CARD_ANCHORS, CHAIN_NAMES, DAY_ZERO, definitionHref } from "@/lib/definitions";
import { formatBps, formatCompact } from "@/lib/format";
import { velocityTakeaway, velocityWarnings } from "@/lib/takeaways/activity";
import { VELOCITY_NOTE, WALLETS_NOTE } from "@/lib/takeaways/caveats";

export type ActivityViewProps = {
  options: ChainOption[];
  activity: ActivityRow[];
  kpis: KpiRow[];
  definitions: Definitions;
  warnings: ManifestWarning[];
  state: DatasetState;
};

const SOURCE = "Chain data and public labels";

const JUMPY_NOTE =
  "A small circulating supply makes velocity jumpy: the same volume over a smaller base gives a bigger percentage.";

const pinnedNote = ({ kind, text, chip }: ActivityNote): PinnedNote => ({
  kind,
  text,
  ...(chip ? { chip } : {}),
});

// Each note's number on the row its pin sits on, by its place in the list, as PinnedNotes counts.
function stepPins(notes: ActivityNote[]): StepPins {
  return Object.fromEntries(
    notes.flatMap((note, index) => (note.step ? [[note.step, index + 1]] : [])),
  );
}

// The notes in full, for the popover. Nothing here is the only copy of a caveat.
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
      chip="inferred"
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
      chip="inferred"
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

export function ActivityView({
  options,
  activity,
  kpis,
  definitions,
  warnings,
  state,
}: ActivityViewProps) {
  const newest = newestByChain(activity);
  const asOf = dayRange(newest.map((row) => row.day)) ?? DAY_ZERO;
  const velocityNotes = velocityWarnings(warnings);
  const dust = formatCompact(definitions.active_dust_base_units);
  const secondary = formatCompact(definitions.active_secondary_base_units);
  const inputs = { activity, kpis, definitions };

  return (
    <section id="real-activity" data-section="view-b" className="card-grid">
      <ChainPanels options={options} id={CARD_ANCHORS.waterfall}>
        {(option) => <WaterfallCard panel={waterfallPanel(option, inputs)} state={state} />}
      </ChainPanels>
      <ChainPanels options={options} id={CARD_ANCHORS.weekly}>
        {(option) => <WeeklyCard panel={weeklyPanel(option, inputs)} state={state} />}
      </ChainPanels>

      <TableCard
        id={CARD_ANCHORS.velocity}
        takeaway={velocityTakeaway(kpis)}
        chip="inferred"
        source={SOURCE}
        asOf={dayRange(kpis.map((row) => row.day)) ?? asOf}
        definitionHref={definitionHref("velocity")}
        frameWord={state.frameWord}
        summary="Velocity, everyday velocity and headline velocity per chain, each beside the supply it divides by, and the wallets active in the last 7 days. Wallets, not people."
        table={{
          caption: "Velocity, denominators and active wallets, newest day per chain",
          columns: [
            { key: "chain", label: "Chain" },
            { key: "velocity", label: "Velocity", numeric: true },
            { key: "everyday", label: "Everyday velocity", numeric: true },
            { key: "circulating", label: "Divided by: circulating supply", numeric: true },
            { key: "headline", label: "Headline velocity", numeric: true },
            { key: "total", label: "Divided by: total supply", numeric: true },
            { key: "wallets", label: `Wallets over ${dust}`, numeric: true },
            { key: "walletsHigh", label: `Wallets over ${secondary}`, numeric: true },
          ],
          rows: kpis.map((row) => ({
            chain: CHAIN_NAMES[row.chain],
            velocity: formatBps(row.velocity_bps),
            everyday: formatBps(row.velocity_everyday_bps),
            circulating: formatCompact(row.circulating_supply),
            headline: formatBps(row.headline_velocity_bps),
            total: formatCompact(row.total_supply),
            wallets: row.active_wallets_7d,
            walletsHigh: row.active_wallets_over_100_7d,
          })),
        }}
        note={
          <>
            <p data-note="wallets-not-people">{WALLETS_NOTE}</p>
            <p className="mt-3" data-note="velocity-denominators">
              {VELOCITY_NOTE}{" "}
              <a href={definitionHref("velocity")} className="underline underline-offset-4">
                How velocity is worked out
              </a>
            </p>
            <p className="mt-3" data-note="velocity-jumpy">
              {JUMPY_NOTE}
            </p>
            {velocityNotes.map((note) => (
              <p
                className="mt-3"
                key={`${note.chain}-${note.day}`}
                data-note="velocity-warning"
                data-chain={note.chain}
              >
                {note.text}
              </p>
            ))}
          </>
        }
      />
    </section>
  );
}
