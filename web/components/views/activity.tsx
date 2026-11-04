import { ChartCard, TableCard } from "@/components/chart-card";
import { HairlineTable } from "@/components/hairline-table";
import { WaterfallChart, WeeklyBars } from "@/components/views/activity-charts";
import { dayRange, floorBps, newestByChain } from "@/lib/aggregate";
import { StatusChip } from "@/components/status-chip";
import type {
  ActivityRow,
  Definitions,
  DatasetState,
  KpiRow,
  ManifestWarning,
} from "@/lib/dataset";
import { CARD_ANCHORS, CHAIN_NAMES, DAY_ZERO, definitionHref } from "@/lib/definitions";
import { formatBps, formatCompact, formatUtcDate, UNKNOWN_TEXT } from "@/lib/format";
import {
  activityChains,
  day0Scope,
  historyLabel,
  perChain,
  velocityTakeaway,
  velocityWarnings,
  waterfall,
  waterfallHeading,
  waterfallTakeaway,
  weeklyEveryday,
  weeklyHeading,
  weeklyTakeaway,
} from "@/lib/takeaways/activity";

export type ActivityViewProps = {
  activity: ActivityRow[];
  kpis: KpiRow[];
  definitions: Definitions;
  warnings: ManifestWarning[];
  state: DatasetState;
};

const SOURCE = "Chain data and public labels";

const VELOCITY_EXPLANATION =
  "Velocity divides clean volume by circulating supply. Headline velocity divides all transfers by total supply. Because circulating supply is smaller, velocity can be higher than headline velocity even though clean volume is smaller than headline volume. They aren't two cuts of one number.";

const JUMPY_NOTE =
  "A small circulating supply makes velocity jumpy: the same volume over a smaller base gives a bigger percentage.";

// A dated fact from the project's own notes, not a dataset field. Issuer flows leave this out.
function SmallTicketNote() {
  return (
    <p data-note="small-ticket">
      <strong>Not in the dataset:</strong> in the week of 26 Oct 2026, Bridge&rsquo;s small-ticket
      issuance, which issuer flows exclude, was $4.07M in 2,441 transfers to 237 recipients, against
      $3.13M of Tempo everyday volume. Its cause is unproven.
    </p>
  );
}

// Said where the waterfall is scoped. A Fact because it is minted minus burned, read from the chain.
function Day0Note({ scope }: { scope: NonNullable<ReturnType<typeof day0Scope>> }) {
  return (
    <p data-note="day-0-scope">
      <StatusChip kind="fact" /> Flows here count from Day 0, {formatUtcDate(DAY_ZERO)}. Supply also
      includes mints from before it: {formatCompact(scope.before)} of the{" "}
      {formatCompact(scope.total)} total.
    </p>
  );
}

function PeriodTable({ activity }: { activity: ActivityRow[] }) {
  return (
    <HairlineTable
      caption="Period covered per chain, Day 0 through each chain's newest day"
      columns={[
        { key: "chain", label: "Chain" },
        { key: "from", label: "First day" },
        { key: "to", label: "Newest day" },
        { key: "days", label: "Days", numeric: true },
        { key: "headline", label: "Headline", numeric: true },
        { key: "large", label: "Clean large", numeric: true },
        { key: "everyday", label: "Clean everyday", numeric: true },
      ]}
      rows={perChain(activity).map((chain) => {
        const sum = waterfall(chain.rows);
        const find = (key: string) => sum?.steps.find((step) => step.key === key)?.amount;
        return {
          chain: CHAIN_NAMES[chain.chain],
          from: formatUtcDate(chain.from),
          to: formatUtcDate(chain.to),
          days: chain.days,
          headline: sum ? formatCompact(sum.headline) : UNKNOWN_TEXT,
          large: formatCompact(find("clean_large")),
          everyday: formatCompact(find("clean_everyday")),
        };
      })}
    />
  );
}

export function ActivityView({ activity, kpis, definitions, warnings, state }: ActivityViewProps) {
  const newest = newestByChain(activity);
  const asOf = dayRange(newest.map((row) => row.day)) ?? DAY_ZERO;
  const all = waterfall(activity);
  const chains = activityChains(activity);
  const scope = day0Scope(activity, kpis);
  const velocityNotes = velocityWarnings(warnings);
  const weeks = weeklyEveryday(activity);
  const everydayLabel = formatCompact(definitions.large_transfer_base_units);
  const dust = formatCompact(definitions.active_dust_base_units);
  const secondary = formatCompact(definitions.active_secondary_base_units);
  const share = (step: string) =>
    all
      ? formatBps(
          floorBps(BigInt(all.steps.find((s) => s.key === step)!.amount), BigInt(all.headline)),
        )
      : UNKNOWN_TEXT;

  return (
    <section id="real-activity" data-section="view-b" className="grid gap-6">
      <ChartCard
        id={CARD_ANCHORS.waterfall}
        takeaway={waterfallHeading(all, chains)}
        detail={<p>{waterfallTakeaway(all)}</p>}
        chip="inferred"
        source={SOURCE}
        asOf={asOf}
        definitionHref={definitionHref("clean-volume")}
        frameWord={state.frameWord}
        summary={
          all
            ? `Headline volume, then each removal in turn, down to clean large (${share("clean_large")} of headline) and clean everyday (${share("clean_everyday")}). Everyday means under ${everydayLabel}, nothing more. Large transfers are split out, not removed. Hops across transactions still count more than once.`
            : UNKNOWN_TEXT
        }
        table={{
          caption:
            "From headline volume to clean volume, all chains, Day 0 through each chain's newest day",
          columns: [
            { key: "step", label: "Step" },
            { key: "amount", label: "Amount", numeric: true },
          ],
          rows: (all?.steps ?? []).map((step) => ({
            step: step.label,
            amount: formatCompact(step.amount),
          })),
        }}
        note={
          <>
            {all ? (
              <>
                <p data-note="everyday-meaning">
                  Everyday means under {everydayLabel}, nothing more.
                </p>
                <p className="mt-3" data-note="hops">
                  Hops across transactions still count more than once.
                </p>
              </>
            ) : null}
            {scope ? <Day0Note scope={scope} /> : null}
            <SmallTicketNote />
            <div className="mt-4">
              <PeriodTable activity={activity} />
            </div>
          </>
        }
      >
        <WaterfallChart waterfall={all} />
      </ChartCard>

      <ChartCard
        id={CARD_ANCHORS.weekly}
        takeaway={weeklyHeading(weeks, chains)}
        detail={<p>{weeklyTakeaway(weeks)}</p>}
        chip="inferred"
        source={SOURCE}
        asOf={asOf}
        definitionHref={definitionHref("everyday-large")}
        frameWord={state.frameWord}
        summary={`Clean everyday volume per week, all chains, for complete weeks only. ${historyLabel(activity)}.`}
        table={{
          caption: "Clean everyday volume per complete week, all chains",
          columns: [
            { key: "week", label: "Week" },
            { key: "everyday", label: "Clean everyday", numeric: true },
          ],
          rows: weeks.map((week) => ({
            week: `${formatUtcDate(week.from).replace(/ UTC$/, "")} to ${formatUtcDate(week.to)}`,
            everyday: formatCompact(week.everyday),
          })),
        }}
      >
        <WeeklyBars weeks={weeks} history={historyLabel(activity)} />
      </ChartCard>

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
            <p data-note="wallets-not-people">Wallets, not people.</p>
            <p className="mt-3" data-note="velocity-denominators">
              {VELOCITY_EXPLANATION}{" "}
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
