import { ChartCard } from "@/components/chart-card";
import type { PinnedNote } from "@/components/pinned-notes";
import { velocityChart, VELOCITY_MEASURES } from "@/lib/chain-views";
import { dayRange } from "@/lib/aggregate";
import type { Definitions, DatasetState, KpiRow, ManifestWarning } from "@/lib/dataset";
import { CARD_ANCHORS, CHAIN_NAMES, DAY_ZERO, definitionHref } from "@/lib/definitions";
import { formatBps, formatCompact } from "@/lib/format";
import { velocityHeading, velocityTakeaway } from "@/lib/takeaways/activity";
import { VELOCITY_NOTE, WALLETS_NOTE } from "@/lib/takeaways/caveats";
import { measureStyle, VelocityChart } from "./velocity-chart";

export type VelocityViewProps = {
  kpis: KpiRow[];
  definitions: Definitions;
  warnings: ManifestWarning[];
  state: DatasetState;
};

export const JUMPY_NOTE =
  "A small circulating supply makes velocity jumpy: the same volume over a smaller base gives a bigger percentage.";

function MeasureLegend() {
  return (
    <ul className="velocity-legend px-4 pt-4" data-velocity-legend>
      {VELOCITY_MEASURES.map(({ key, label }) => (
        <li key={key}>
          <span className="velocity-legend__swatch" style={measureStyle(key)} />
          {label === "Velocity" ? label : `${label} velocity`}
        </li>
      ))}
    </ul>
  );
}

// Velocity, everyday velocity and headline velocity for every chain. It compares chains, so a filter
// option highlights its chain rather than dropping the others.
export function VelocityCard({ kpis, definitions, warnings, state }: VelocityViewProps) {
  const chart = velocityChart(kpis, warnings);
  const notes: PinnedNote[] = chart.notes.map(({ kind, chain, text }) => ({ kind, chain, text }));
  const pins = Object.fromEntries(
    chart.notes.flatMap((note, index) => (note.chain ? [[note.chain, index + 1]] : [])),
  );
  const dust = formatCompact(definitions.active_dust_base_units);
  const secondary = formatCompact(definitions.active_secondary_base_units);
  return (
    <ChartCard
      id={CARD_ANCHORS.velocity}
      takeaway={velocityHeading(kpis)}
      detail={
        <>
          <p>{velocityTakeaway(kpis)}</p>
          <p data-full-note="velocity-denominators">
            {VELOCITY_NOTE}{" "}
            <a
              href={definitionHref("velocity")}
              className="target-link underline underline-offset-4"
            >
              How velocity is worked out
            </a>
          </p>
          <p data-full-note="velocity-jumpy">{JUMPY_NOTE}</p>
          {chart.fullWarnings.map(({ chain, text }) => (
            <p key={chain} data-full-note="velocity-warning" data-chain={chain}>
              {text}
            </p>
          ))}
        </>
      }
      chip="inferred"
      source="Chain data and public labels"
      asOf={dayRange(kpis.map((row) => row.day)) ?? DAY_ZERO}
      definitionHref={definitionHref("velocity")}
      frameWord={state.frameWord}
      summary="Velocity, everyday velocity and headline velocity per chain, on one scale from zero. The table has each beside the supply it divides by, and the wallets active in the last 7 days. Wallets, not people."
      notes={notes}
      table={{
        caption: `Velocity, denominators and active wallets, newest day per chain. ${WALLETS_NOTE}`,
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
    >
      {chart.max === null ? null : <MeasureLegend />}
      <VelocityChart chart={chart} pins={pins} />
    </ChartCard>
  );
}
