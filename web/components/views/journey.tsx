import { ChartCard, TableCard } from "@/components/chart-card";
import { allChainJourney, allChainSeries, dayRange, newestByChain } from "@/lib/aggregate";
import type { ActivityRow, Definitions, DatasetState, JourneyRow, KpiRow } from "@/lib/dataset";
import { CHAIN_NAMES, definitionHref, REQUIRED_CHAINS } from "@/lib/definitions";
import { formatBps, formatCompact, formatExact, formatUtcDate, UNKNOWN_TEXT } from "@/lib/format";
import {
  journeyTakeaway,
  scopeText,
  seriesTakeaway,
  top10ShareBps,
  volumeTakeaway,
} from "@/lib/takeaways/journey";
import { BarLegend, SupplyBars, SupplySeries, type BarRow } from "./journey-charts";

export type JourneyViewProps = {
  journey: JourneyRow[];
  activity: ActivityRow[];
  kpis: KpiRow[];
  definitions: Definitions;
  state: DatasetState;
};

const SOURCE = "Chain data and public labels";

function VenueNote({ unlabeled }: { unlabeled: string[] }) {
  return (
    <>
      <p>
        Placed measures dollars that stayed, not why. It can&apos;t show who holds them or what they
        are for, and a venue with no published label can count as placed, exchange custody included.{" "}
        <a href={definitionHref("venue-supply")} className="underline underline-offset-4">
          How venues are labelled
        </a>
        .
      </p>
      {unlabeled.map((name) => (
        <p key={name} className="mt-2" data-testid="issuer-unlabeled">
          {name}: issuer inventory reads as zero because no wallet there is labelled.
        </p>
      ))}
    </>
  );
}

// Circulating comes from activity, and only from the day the journey row is from, so a figure beside
// a bar never belongs to another day.
function circulatingByChain(
  newest: JourneyRow[],
  activity: ActivityRow[],
): Map<string, string | null> {
  const byDay = new Map(activity.map((row) => [`${row.chain}|${row.day}`, row.circulating_supply]));
  return new Map(newest.map((row) => [row.chain, byDay.get(`${row.chain}|${row.day}`) ?? null]));
}

function barRows(newest: JourneyRow[], activity: ActivityRow[]): BarRow[] {
  const circulating = circulatingByChain(newest, activity);
  const all = allChainJourney(newest);
  const circulatingValues = newest.map((row) => circulating.get(row.chain) ?? null);
  const allCirculating = circulatingValues.some((value) => value === null)
    ? null
    : circulatingValues.reduce((sum, value) => sum + BigInt(value!), 0n).toString();
  const rows: BarRow[] = newest.map((row) => ({
    key: row.chain,
    name: CHAIN_NAMES[row.chain],
    day: formatUtcDate(row.day),
    journey: row,
    circulating: circulating.get(row.chain) ?? null,
  }));
  if (!all) return rows;
  return [
    {
      key: "all",
      name: `${newest.length === REQUIRED_CHAINS.length ? "All four chains" : scopeText(all.chains)}`,
      day:
        all.asOf.from === all.asOf.to
          ? formatUtcDate(all.asOf.from)
          : `${formatUtcDate(all.asOf.from)} to ${formatUtcDate(all.asOf.to)}`,
      journey: all,
      circulating: allCirculating,
    },
    ...rows,
  ];
}

function seriesFor(
  journey: JourneyRow[],
  activity: ActivityRow[],
  chains: JourneyRow["chain"][],
  firstDay: string,
) {
  const base = allChainSeries(journey, chains, ["total_supply", "placed_supply"]);
  const circulating = new Map(
    allChainSeries(activity, chains, ["circulating_supply"]).map((p) => [
      p.day,
      p.circulating_supply,
    ]),
  );
  return base
    .filter((point) => point.day >= firstDay && circulating.has(point.day))
    .map((point) => ({ ...point, circulating_supply: circulating.get(point.day)! }));
}

export function JourneyView({ journey, activity, kpis, definitions, state }: JourneyViewProps) {
  const newest = newestByChain(journey);
  const asOf = dayRange(newest.map((row) => row.day)) ?? definitions.journey_first_day;
  const chains = newest.map((row) => row.chain);
  const rows = barRows(newest, activity);
  const kpiNewest = newestByChain(kpis);
  const kpiAsOf = dayRange(kpiNewest.map((row) => row.day)) ?? definitions.journey_first_day;
  const series = seriesFor(journey, activity, chains, definitions.journey_first_day);
  const seriesAsOf = series.length > 0 ? dayRange(series.map((p) => p.day))! : asOf;
  const unlabeled = newest
    .filter((row) => !row.issuer_labeled && BigInt(row.issuer_inventory) === 0n)
    .map((row) => CHAIN_NAMES[row.chain]);
  const takeaway = journeyTakeaway(journey, definitions);

  const circulatingOf = circulatingByChain(newest, activity);

  return (
    <section id="supply-journey" data-section="view-a" className="grid gap-6">
      <ChartCard
        takeaway={takeaway}
        chip="inferred"
        source={SOURCE}
        asOf={asOf}
        definitionHref={definitionHref("placed-supply")}
        frameWord={state.frameWord}
        summary={
          newest.length === 0
            ? UNKNOWN_TEXT
            : `Where supply sits on ${scopeText(chains)}: issuer inventory, placed, DEX, lending and exchange venues, and free-floating. Circulating is everything except issuer inventory and placed.`
        }
        note={<VenueNote unlabeled={unlabeled} />}
        table={{
          caption: "Supply by part, newest day per chain",
          columns: [
            { key: "chain", label: "Chain" },
            { key: "day", label: "Day" },
            { key: "total", label: "Total", numeric: true },
            { key: "issuer", label: "Issuer inventory", numeric: true },
            { key: "placed", label: "Placed", numeric: true },
            { key: "dex", label: "DEX venues", numeric: true },
            { key: "lending", label: "Lending venues", numeric: true },
            { key: "exchange", label: "Exchange venues", numeric: true },
            { key: "free", label: "Free-floating", numeric: true },
            { key: "circulating", label: "Circulating", numeric: true },
            { key: "holders", label: "Holders", numeric: true },
            { key: "large", label: "Holders of $1M or more", numeric: true },
            { key: "top10", label: "Top-10 share of supply", numeric: true },
          ],
          rows: newest.map((row) => ({
            chain: CHAIN_NAMES[row.chain],
            day: formatUtcDate(row.day),
            total: formatExact(row.total_supply),
            issuer: formatExact(row.issuer_inventory),
            placed: formatExact(row.placed_supply),
            dex: formatExact(row.venue_dex),
            lending: formatExact(row.venue_lending),
            exchange: formatExact(row.venue_exchange),
            free: formatExact(row.free_floating),
            circulating: formatExact(circulatingOf.get(row.chain)),
            holders: row.holders.toLocaleString("en-US"),
            large: row.holders_over_1m.toLocaleString("en-US"),
            top10: formatBps(top10ShareBps(row)),
          })),
        }}
      >
        {rows.length === 0 ? <p className="p-4">{UNKNOWN_TEXT}</p> : <SupplyBars rows={rows} />}
        {rows.length === 0 ? null : <BarLegend />}
      </ChartCard>

      <ChartCard
        takeaway={seriesTakeaway(series, chains)}
        chip="inferred"
        source={SOURCE}
        asOf={seriesAsOf}
        definitionHref={definitionHref("placed-supply")}
        frameWord={state.frameWord}
        needsJs={series.length > 0}
        summary={
          series.length === 0
            ? UNKNOWN_TEXT
            : `Total, placed and circulating supply over time on ${scopeText(chains)}, from ${formatUtcDate(series[0].day)}.`
        }
        note={
          <p>
            The series starts on {formatUtcDate(definitions.journey_first_day)}. Placed supply needs{" "}
            {definitions.placed_days} days of history, so earlier days are left out. Days where a
            chain has no value are skipped. Per-chain values are in the first card&apos;s table.
          </p>
        }
        table={{
          caption: "Supply over time, chains summed",
          columns: [
            { key: "day", label: "Day" },
            { key: "total", label: "Total", numeric: true },
            { key: "placed", label: "Placed", numeric: true },
            { key: "circulating", label: "Circulating", numeric: true },
          ],
          rows: series.map((point) => ({
            day: formatUtcDate(point.day),
            total: formatExact(point.total_supply),
            placed: formatExact(point.placed_supply),
            circulating: formatExact(point.circulating_supply),
          })),
        }}
      >
        <SupplySeries series={series} />
      </ChartCard>

      <TableCard
        level={3}
        takeaway={volumeTakeaway(kpiNewest)}
        chip="inferred"
        source={SOURCE}
        asOf={kpiAsOf}
        definitionHref={definitionHref("active-wallets")}
        frameWord={state.frameWord}
        summary="Clean volume and active wallets sit beside the supply parts because they are flows, not slices of a balance. Wallets, not people, and never added across chains."
        table={{
          caption: "Last 7 days, per chain",
          columns: [
            { key: "chain", label: "Chain" },
            { key: "day", label: "Day" },
            { key: "clean", label: "Clean volume, 7 days", numeric: true },
            { key: "wallets", label: "Active wallets, 7 days", numeric: true },
          ],
          rows: kpiNewest.map((row) => ({
            chain: CHAIN_NAMES[row.chain],
            day: formatUtcDate(row.day),
            clean: `${formatCompact(row.clean_7d)} (${formatExact(row.clean_7d)})`,
            wallets: row.active_wallets_7d.toLocaleString("en-US"),
          })),
        }}
      />
    </section>
  );
}
