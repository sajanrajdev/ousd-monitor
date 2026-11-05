import { ChainPanels } from "@/components/chain-panels";
import { ChartCard } from "@/components/chart-card";
import { ExchangeRows } from "@/components/exchange-rows";
import { HairlineTable } from "@/components/hairline-table";
import { PinMark, type PinnedNote } from "@/components/pinned-notes";
import { StatusChip } from "@/components/status-chip";
import { dayRange } from "@/lib/aggregate";
import type { ChainOption } from "@/lib/chain-scope";
import type { ActivityRow, Definitions, DatasetState, JourneyRow, KpiRow } from "@/lib/dataset";
import { CARD_ANCHORS, CHAIN_NAMES, definitionHref } from "@/lib/definitions";
import type { ExchangeRow } from "@/lib/exchange-rows";
import { formatBps, formatCompact, formatExact, formatUtcDate, UNKNOWN_TEXT } from "@/lib/format";
import {
  legendAmount,
  segmentLabel,
  SEGMENT_CONFIG,
  seriesPanel,
  supplyPanel,
  withoutEntities,
  type SegmentConfig,
  type SegmentNote,
  type SupplyPanel,
  type SupplySegment,
} from "@/lib/supply-segments";
import { PLACED_NOTE, seriesStartNote, WALLETS_ACROSS_CHAINS_NOTE } from "@/lib/takeaways/caveats";
import {
  journeyTakeaway,
  scopeText,
  seriesTakeaway,
  volumeTakeaway,
} from "@/lib/takeaways/journey";
import { SeriesLegend, SupplyBar, SupplySeries } from "./journey-charts";

export type JourneyViewProps = {
  options: ChainOption[];
  journey: JourneyRow[];
  activity: ActivityRow[];
  kpis: KpiRow[];
  definitions: Definitions;
  state: DatasetState;
  exchanges: ExchangeRow[];
  // Only a test passes this, to show a segment added here reaches the bar, legend and table.
  segmentConfig?: SegmentConfig[];
};

const SOURCE = "Chain data and public labels";

function pinnedNote({ kind, chain, text, link }: SegmentNote): PinnedNote {
  return {
    kind,
    chain,
    text: link ? (
      <>
        {text}{" "}
        <a href={link.href} className="underline underline-offset-4">
          {link.text}
        </a>
        .
      </>
    ) : (
      text
    ),
  };
}

// Each note's number, by the segment it belongs to. A number is the note's place in the list, as in
// PinnedNotes, so the legend and bar can't point at another note.
function pinsOf(notes: SegmentNote[]): Record<string, number[]> {
  const pins: Record<string, number[]> = {};
  notes.forEach(({ segment }, index) => {
    if (segment) pins[segment] = [...(pins[segment] ?? []), index + 1];
  });
  return pins;
}

function LegendRow({ segment, pins }: { segment: SupplySegment; pins: number[] }) {
  const { style } = segment;
  return (
    <li className="chart-legend__row" data-segment={segment.key}>
      <span
        aria-hidden="true"
        className="chart-legend__swatch"
        data-outlined={style.outlined ? "" : undefined}
        style={{
          background: style.image ? `${style.image}, ${style.background}` : style.background,
        }}
      />
      <span className="chart-legend__label">
        <span data-segment-label>{segmentLabel(segment)}</span> <StatusChip kind={segment.marker} />
        {pins.map((number) => (
          <PinMark key={number} number={number} />
        ))}
      </span>
      <span className="chart-legend__values">
        <span data-segment-amount>
          {segment.coverage === "floor" ? (
            <span aria-hidden="true" data-coverage="floor">
              ≥
            </span>
          ) : null}
          {legendAmount(segment)}
        </span>{" "}
        <span data-segment-share>{formatBps(segment.shareBps)}</span>
      </span>
    </li>
  );
}

// Every segment on every panel, zero included, so the legend doesn't jump between filter options. The
// band's line says what it marks inside its segment, and carries data-exchange-linked only when
// there's a band to mark.
function SupplyLegend({ panel, pins }: { panel: SupplyPanel; pins: Record<string, number[]> }) {
  const key = panel.bar?.key;
  return (
    <ul className="chart-legend" data-supply-legend>
      {panel.segments.flatMap((segment) => [
        <LegendRow key={segment.key} segment={segment} pins={pins[segment.key] ?? []} />,
        ...(segment.band
          ? [
              <li key={`${segment.key}:band`} className="chart-legend__row" data-band={segment.key}>
                <span
                  aria-hidden="true"
                  className="chart-legend__swatch"
                  data-outlined=""
                  style={{ background: segment.band.background }}
                />
                <span
                  className="chart-legend__band"
                  data-testid="exchange-linked"
                  data-exchange-linked={BigInt(segment.band.amount) > 0n ? key : undefined}
                >
                  {segment.band.line}
                </span>
              </li>,
            ]
          : []),
      ])}
    </ul>
  );
}

function SupplyStats({ panel, walletPin }: { panel: SupplyPanel; walletPin: number }) {
  return (
    <dl className="chart-stats">
      {panel.stats.map(({ key, label, value }) => (
        <div key={key} data-stat={key}>
          <dt>
            {label}
            {key === "active-wallets" ? <PinMark number={walletPin} /> : null}
          </dt>
          <dd data-stat-value>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SupplyDetail({ panel, definitions }: { panel: SupplyPanel; definitions: Definitions }) {
  const links = [...new Map(panel.segments.map((s) => [s.definition, s])).values()];
  return (
    <>
      <p>{journeyTakeaway(panel.rows, definitions)}</p>
      <p data-full-note="placed">
        {PLACED_NOTE}{" "}
        <a
          href={definitionHref("venue-supply")}
          className="target-link underline underline-offset-4"
        >
          How venues are labelled
        </a>
        .
      </p>
      <p>Circulating comes from activity data.</p>
      <p>{volumeTakeaway(panel.kpis)}</p>
      <p>
        Clean volume and active wallets sit beside the supply parts because they are flows, not
        slices of a balance.
      </p>
      <ul className="info-popover__links">
        {links.map((segment) => (
          <li key={segment.definition}>
            <a
              href={definitionHref(segment.definition)}
              className="target-link underline underline-offset-4"
            >
              {segment.definition === "venue-supply" ? "Venues" : segment.label}
            </a>
          </li>
        ))}
        <li>
          <a
            href={definitionHref("active-wallets")}
            className="target-link underline underline-offset-4"
          >
            Active wallets
          </a>
        </li>
      </ul>
    </>
  );
}

function SupplyCard({
  panel,
  definitions,
  state,
}: {
  panel: SupplyPanel;
  definitions: Definitions;
  state: DatasetState;
}) {
  const { chains, rows, kpis } = panel;
  const asOf = dayRange(rows.map((row) => row.day)) ?? definitions.journey_first_day;
  const pins = pinsOf(panel.notes);
  const entities = panel.segments.flatMap((segment) => segment.entities ?? []);
  return (
    <ChartCard
      takeaway={panel.heading}
      detail={<SupplyDetail panel={panel} definitions={definitions} />}
      chip="inferred"
      source={SOURCE}
      asOf={asOf}
      definitionHref={definitionHref("placed-supply")}
      frameWord={state.frameWord}
      summary={
        rows.length === 0
          ? UNKNOWN_TEXT
          : `Where supply sits on ${scopeText(chains)}: issuer inventory, placed, DEX, lending and exchange venues, and free-floating. Circulating is everything except issuer inventory and placed.`
      }
      notes={panel.notes.map(pinnedNote)}
      beside={
        panel.bar ? (
          <>
            <SupplyLegend panel={panel} pins={pins} />
            <SupplyStats panel={panel} walletPin={panel.notes.length} />
          </>
        ) : null
      }
      table={panel.table}
      moreTables={
        <>
          <HairlineTable
            caption={`Last 7 days, per chain. ${WALLETS_ACROSS_CHAINS_NOTE}`}
            columns={[
              { key: "chain", label: "Chain" },
              { key: "day", label: "Day" },
              { key: "clean", label: "Clean volume, 7 days", numeric: true },
              { key: "wallets", label: "Active wallets, 7 days", numeric: true },
            ]}
            rows={kpis.map((row) => ({
              chain: CHAIN_NAMES[row.chain],
              day: formatUtcDate(row.day),
              clean: `${formatCompact(row.clean_7d)} (${formatExact(row.clean_7d)})`,
              wallets: row.active_wallets_7d.toLocaleString("en-US"),
            }))}
          />
          {entities.length > 0 ? (
            <div data-labels-table>
              <p className="font-semibold">Named exchanges, across chains</p>
              <ExchangeRows rows={entities} />
            </div>
          ) : null}
        </>
      }
    >
      {panel.bar ? (
        <SupplyBar
          row={panel.bar}
          segments={panel.segments.map(withoutEntities)}
          pins={Object.fromEntries(Object.entries(pins).map(([key, numbers]) => [key, numbers[0]]))}
        />
      ) : (
        <p className="p-4">{UNKNOWN_TEXT}</p>
      )}
    </ChartCard>
  );
}

function SeriesCard({
  panel: { option, series, heading, notes, latest, tableRows },
  definitions,
  state,
}: {
  panel: ReturnType<typeof seriesPanel>;
  definitions: Definitions;
  state: DatasetState;
}) {
  const { chains } = option;
  const asOf = dayRange(series.map((point) => point.day)) ?? definitions.journey_first_day;
  const scope = option.value === "all" ? "chains summed" : CHAIN_NAMES[option.value];
  return (
    <ChartCard
      takeaway={heading}
      detail={
        <>
          <p>{seriesTakeaway(series, chains)}</p>
          <p data-full-note="series-start">{seriesStartNote(definitions)}</p>
        </>
      }
      chip="inferred"
      source={SOURCE}
      asOf={asOf}
      definitionHref={definitionHref("placed-supply")}
      frameWord={state.frameWord}
      needsJs={series.length > 0}
      summary={
        series.length === 0
          ? UNKNOWN_TEXT
          : `Total, placed and circulating supply over time on ${scopeText(chains)}, from ${formatUtcDate(series[0].day)}.`
      }
      notes={notes}
      beside={latest ? <SeriesLegend latest={latest} /> : null}
      table={{
        caption: `Supply over time, ${scope}`,
        columns: [
          { key: "day", label: "Day" },
          { key: "total", label: "Total", numeric: true },
          { key: "placed", label: "Placed", numeric: true },
          { key: "circulating", label: "Circulating", numeric: true },
        ],
        rows: tableRows,
      }}
    >
      <SupplySeries series={series} panel={option.value} />
    </ChartCard>
  );
}

export function JourneyView({
  options,
  journey,
  activity,
  kpis,
  definitions,
  state,
  exchanges,
  segmentConfig = SEGMENT_CONFIG,
}: JourneyViewProps) {
  return (
    <section id="supply-journey" data-section="view-a" className="card-grid">
      <ChainPanels options={options} id={CARD_ANCHORS.supply}>
        {(option) => (
          <SupplyCard
            panel={supplyPanel(option, {
              journey,
              activity,
              kpis,
              definitions,
              exchanges,
              config: segmentConfig,
            })}
            definitions={definitions}
            state={state}
          />
        )}
      </ChainPanels>
      <ChainPanels options={options} id={CARD_ANCHORS.series}>
        {(option) => (
          <SeriesCard
            panel={seriesPanel(option, { journey, activity, definitions })}
            definitions={definitions}
            state={state}
          />
        )}
      </ChainPanels>
    </section>
  );
}
