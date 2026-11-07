import { dayRange, floorBps, newestByChain } from "./aggregate.ts";
import type { ChainOption } from "./chain-scope.ts";
import type { ActivityRow, ChainName, Definitions, KpiRow } from "./dataset/rows.ts";
import { CHAIN_NAMES, DAY_ZERO } from "./definitions.ts";
import { formatBps, formatCompact, formatUtcDate, UNKNOWN_TEXT, type AsOfRange } from "./format.ts";
import {
  activityChains,
  day0Scope,
  historyLabel,
  perChain,
  waterfall,
  waterfallHeading,
  waterfallTakeaway,
  weeklyEveryday,
  weeklyHeading,
  weeklyTakeaway,
  type Waterfall,
  type WaterfallStep,
  type Week,
} from "./takeaways/activity.ts";
import {
  day0Note,
  day0Pin,
  everydayNote,
  historyNote,
  historyPin,
  HOPS_NOTE,
  SMALL_TICKET_LEAD,
  SMALL_TICKET_NOTE,
  SMALL_TICKET_PIN,
} from "./takeaways/caveats.ts";

// A caveat a card pins, with the words the views show and verify-output expects. `step` is the
// waterfall row its pin sits on.
export type ActivityNote = {
  kind: string;
  text: string;
  step?: WaterfallStep["key"];
};

export type ActivityInputs = {
  activity: ActivityRow[];
  kpis: KpiRow[];
  definitions: Definitions;
};

type Table = { rows: Record<string, string>[] };

export type WaterfallPanel = {
  option: ChainOption;
  chains: ChainName[];
  waterfall: Waterfall | null;
  heading: string;
  takeaway: string;
  summary: string;
  asOf: string | AsOfRange;
  notes: ActivityNote[];
  // The notes in full, for the tooltip, by kind.
  fullNotes: Record<string, string>;
  steps: Table;
  periods: Table;
};

export type WeeklyPanel = {
  option: ChainOption;
  chains: ChainName[];
  weeks: Week[];
  heading: string;
  takeaway: string;
  summary: string;
  asOf: string | AsOfRange;
  notes: ActivityNote[];
  fullNotes: Record<string, string>;
  table: Table;
};

// Words for a table's caption: "all chains" only when it is all four.
export function scopeWords(chains: ChainName[]): string {
  if (chains.length === Object.keys(CHAIN_NAMES).length) return "all chains";
  if (chains.length === 0) return UNKNOWN_TEXT;
  const names = chains.map((chain) => CHAIN_NAMES[chain]);
  return names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const rowsOf = (activity: ActivityRow[], option: ChainOption) =>
  activity.filter((row) => option.chains.includes(row.chain));

function asOfOf(rows: ActivityRow[]): string | AsOfRange {
  return dayRange(newestByChain(rows).map((row) => row.day)) ?? DAY_ZERO;
}

// The small-ticket figure compares with Tempo's everyday volume, so it is pinned where Tempo is.
function showsSmallTicket(option: ChainOption): boolean {
  return option.value === "all" || option.value === "tempo";
}

function share(wf: Waterfall, key: WaterfallStep["key"]): string {
  const step = wf.steps.find((candidate) => candidate.key === key)!;
  return formatBps(floorBps(BigInt(step.amount), BigInt(wf.headline)));
}

// Everything one filter option's waterfall card shows, for the view and for verify-output alike.
// Notes run top to bottom in the order their rows do, so pin numbers go down the chart.
export function waterfallPanel(
  option: ChainOption,
  { activity, kpis, definitions }: ActivityInputs,
): WaterfallPanel {
  const rows = rowsOf(activity, option);
  const wf = waterfall(rows);
  const scope = day0Scope(
    rows,
    kpis.filter((row) => option.chains.includes(row.chain)),
  );
  // A pin sits on a drawn row, so with no waterfall the notes stay in the list with no pin.
  const on = (step: WaterfallStep["key"]) => (wf ? { step } : {});
  const chainName = option.value === "all" ? undefined : CHAIN_NAMES[option.value];
  const notes: ActivityNote[] = [
    ...(scope
      ? [
          {
            kind: "day-0-scope",
            text: day0Pin(scope, chainName),
            ...on("headline_value"),
          },
        ]
      : []),
    ...(showsSmallTicket(option)
      ? [{ kind: "small-ticket", text: SMALL_TICKET_PIN, ...on("issuer_flows") }]
      : []),
    ...(wf ? [{ kind: "hops", text: HOPS_NOTE, step: "clean_large" as const }] : []),
  ];
  const fullNotes: Record<string, string> = {
    ...(scope ? { "day-0-scope": day0Note(scope) } : {}),
    ...(showsSmallTicket(option)
      ? { "small-ticket": `${SMALL_TICKET_LEAD} ${SMALL_TICKET_NOTE}` }
      : {}),
  };
  const everyday = formatCompact(definitions.large_transfer_base_units);
  return {
    option,
    chains: option.chains,
    waterfall: wf,
    heading: waterfallHeading(wf, activityChains(rows)),
    takeaway: waterfallTakeaway(wf),
    summary: wf
      ? `Headline volume, then each removal in turn, down to clean large (${share(wf, "clean_large")} of headline) and clean everyday (${share(wf, "clean_everyday")}). Everyday means under ${everyday}, nothing more. Large transfers are split out, not removed. Hops across transactions still count more than once.`
      : UNKNOWN_TEXT,
    asOf: asOfOf(rows),
    notes,
    fullNotes,
    steps: {
      rows: (wf?.steps ?? []).map((step) => ({
        step: step.label,
        amount: formatCompact(step.amount),
      })),
    },
    periods: {
      rows: perChain(rows).map((chain) => {
        const sum = waterfall(chain.rows);
        const find = (key: string) => sum?.steps.find((step) => step.key === key)?.amount;
        return {
          chain: CHAIN_NAMES[chain.chain],
          from: formatUtcDate(chain.from),
          to: formatUtcDate(chain.to),
          days: String(chain.days),
          headline: sum ? formatCompact(sum.headline) : UNKNOWN_TEXT,
          large: formatCompact(find("clean_large")),
          everyday: formatCompact(find("clean_everyday")),
        };
      }),
    },
  };
}

// Everything one filter option's weekly card shows. The weeks are the whole dataset's, so a week
// means the same dates under every option.
export function weeklyPanel(
  option: ChainOption,
  { activity, definitions }: ActivityInputs,
): WeeklyPanel {
  const rows = rowsOf(activity, option);
  const weeks = weeklyEveryday(activity, option.value === "all" ? undefined : option.chains);
  const history = historyLabel(rows);
  const notes: ActivityNote[] = [
    { kind: "everyday-meaning", text: everydayNote(definitions) },
    ...(weeks.length > 0 ? [{ kind: "history", text: historyPin(history) }] : []),
  ];
  return {
    option,
    chains: option.chains,
    weeks,
    heading: weeklyHeading(weeks, activityChains(rows)),
    takeaway: weeklyTakeaway(weeks),
    summary: `Clean everyday volume per week, ${scopeWords(activityChains(rows))}, for complete weeks only. ${history}.`,
    asOf: asOfOf(rows),
    notes,
    fullNotes: weeks.length > 0 ? { history: historyNote(history) } : {},
    table: {
      rows: weeks.map((week) => ({
        week: `${formatUtcDate(week.from).replace(/ UTC$/, "")} to ${formatUtcDate(week.to)}`,
        everyday: formatCompact(week.everyday),
      })),
    },
  };
}

export const STEP_COLUMNS = [
  { key: "step", label: "Step" },
  { key: "amount", label: "Amount", numeric: true },
];

export const PERIOD_COLUMNS = [
  { key: "chain", label: "Chain" },
  { key: "from", label: "First day" },
  { key: "to", label: "Newest day" },
  { key: "days", label: "Days", numeric: true },
  { key: "headline", label: "Headline", numeric: true },
  { key: "large", label: "Clean large", numeric: true },
  { key: "everyday", label: "Clean everyday", numeric: true },
];

export const WEEK_COLUMNS = [
  { key: "week", label: "Week" },
  { key: "everyday", label: "Clean everyday", numeric: true },
];
