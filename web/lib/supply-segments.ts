import {
  allChainJourney,
  allChainSeries,
  floorBps,
  newestByChain,
  type JourneyAmounts,
} from "./aggregate.ts";
import type { ChainOption } from "./chain-scope.ts";
import type { ActivityRow, ChainName, Definitions, JourneyRow, KpiRow } from "./dataset/rows.ts";
import { CHAIN_NAMES, definitionHref, type DefinitionAnchor } from "./definitions.ts";
import type { ExchangeRow } from "./exchange-rows.ts";
import {
  formatBps,
  formatCompact,
  formatExact,
  formatFloorDollars,
  formatUtcDate,
  UNKNOWN_TEXT,
} from "./format.ts";
import {
  EXCHANGE_FLOOR_LINK,
  EXCHANGE_FLOOR_NOTE,
  EXCHANGE_FLOOR_PIN,
  exchangeCoverageNote,
  exchangeCoveragePin,
  issuerUnlabeledNote,
  PLACED_NOTE,
  PLACED_PIN,
  seriesStartNote,
  seriesStartPin,
  WALLETS_NOTE,
  WALLETS_TABLE_NOTE,
} from "./takeaways/caveats.ts";
import {
  EXCHANGE_LINKED_LABEL,
  exchangeLinkedLine,
  journeyHeading,
  seriesHeading,
  top10ShareBps,
} from "./takeaways/journey.ts";

// Meaning colours, plus a pattern where the design system asks for one, so colour is never alone.
// Only marks in ramp steps 3 and 4 (removed, idle) get the maroon hairline outline the design
// system asks for. The other segments differ from their neighbours by colour and are left bare.
const HATCH =
  "repeating-linear-gradient(45deg, transparent 0 4px, color-mix(in srgb, var(--color-maroon-dark) 45%, transparent) 4px 6px)";
const DOTS =
  "radial-gradient(color-mix(in srgb, var(--color-off-white) 70%, transparent) 1.5px, transparent 1.6px) 0 0 / 8px 8px";
const BANDS =
  "repeating-linear-gradient(0deg, transparent 0 3px, color-mix(in srgb, var(--color-maroon-dark) 45%, transparent) 3px 5px)";

export type SegmentStyle = {
  background: string;
  image?: string;
  color: string;
  outlined?: boolean;
};

// A caveat a segment needs, with the words the views show and verify-output expects. `text` stays in
// view. `tip` is the caveat in full, in a tooltip on those words, with `link` after it.
export type SegmentNote = {
  kind: string;
  chain?: ChainName;
  text: string;
  tip?: string;
  link?: { href: string; text: string };
  segment?: string;
};

export type SegmentContext = { rows: JourneyRow[] };

export type SegmentConfig = {
  // The amount this segment reads from the row, in the row's own base units.
  key: string;
  label: string;
  style: SegmentStyle;
  definition: DefinitionAnchor;
  // Whether the bracket for circulating covers it.
  circulating: boolean;
  // A part of this segment marked inside it, which doesn't change the segment.
  band?: { key: keyof JourneyAmounts; label: string; image: string };
  notes?: (context: SegmentContext) => SegmentNote[];
};

// In the order the bar draws them, and the order JOURNEY_PARTS adds up in.
export const SEGMENT_CONFIG: SegmentConfig[] = [
  {
    key: "issuer_inventory",
    label: "Issuer inventory",
    style: {
      background: "var(--meaning-removed)",
      image: HATCH,
      color: "var(--color-maroon-dark)",
      outlined: true,
    },
    definition: "issuer-inventory",
    circulating: false,
    notes: ({ rows }) =>
      rows
        .filter((row) => !row.issuer_labeled && BigInt(row.issuer_inventory) === 0n)
        .map(({ chain }) => ({
          kind: "issuer-unlabeled",
          chain,
          text: issuerUnlabeledNote(chain),
        })),
  },
  {
    key: "placed_supply",
    label: "Placed",
    style: {
      background: "var(--meaning-idle)",
      color: "var(--color-maroon-dark)",
      outlined: true,
    },
    definition: "placed-supply",
    circulating: false,
    band: { key: "placed_exchange_linked", label: EXCHANGE_LINKED_LABEL, image: BANDS },
    notes: () => [{ kind: "placed", text: PLACED_PIN, tip: PLACED_NOTE }],
  },
  {
    key: "venue_dex",
    label: "DEX venues",
    style: { background: "var(--meaning-circulating)", color: "var(--color-off-white)" },
    definition: "venue-supply",
    circulating: true,
  },
  {
    key: "venue_lending",
    label: "Lending venues",
    style: {
      background: "var(--meaning-circulating)",
      image: HATCH,
      color: "var(--color-off-white)",
    },
    definition: "venue-supply",
    circulating: true,
  },
  {
    key: "venue_exchange",
    label: "Exchange venues",
    style: {
      background: "var(--meaning-circulating)",
      image: DOTS,
      color: "var(--color-off-white)",
    },
    definition: "venue-supply",
    circulating: true,
    notes: ({ rows }) => [
      {
        kind: "exchange-floor",
        text: EXCHANGE_FLOOR_PIN,
        tip: EXCHANGE_FLOOR_NOTE,
        link: { href: definitionHref("exchange-linked-placed"), text: EXCHANGE_FLOOR_LINK },
      },
      ...rows
        .filter((row) => BigInt(row.venue_exchange) === 0n)
        .map(({ chain }) => ({
          kind: "exchange-coverage",
          chain,
          text: exchangeCoveragePin(chain),
          tip: exchangeCoverageNote(chain),
        })),
    ],
  },
  {
    key: "free_floating",
    label: "Free-floating",
    style: { background: "var(--meaning-active)", color: "var(--color-off-white)" },
    definition: "free-floating",
    circulating: true,
  },
];

export type SegmentExtra = { coverage?: "floor"; entities?: ExchangeRow[] };
export type SegmentExtras = Record<string, SegmentExtra>;

export type SegmentBand = {
  label: string;
  background: string;
  amount: string;
  // Of the segment it sits in, for geometry. The line says its share of supply.
  shareOfSegmentBps: number;
  line: string;
};

// What the bar, legend and table read. Plain data, so it can reach a client component.
export type SupplySegment = Omit<SegmentConfig, "band" | "notes"> & {
  amount: string;
  shareBps: number | null;
  coverage?: "floor";
  entities?: ExchangeRow[];
  band?: SegmentBand;
};

export type DrawnSegment = Omit<SupplySegment, "entities">;

type SegmentRow = Pick<JourneyAmounts, "total_supply" | "placed_exchange_linked"> &
  Record<string, unknown>;

function bandOf(config: SegmentConfig, row: SegmentRow, amount: bigint): SegmentBand | undefined {
  if (!config.band) return undefined;
  const banded = String(row[config.band.key]);
  return {
    label: config.band.label,
    background: `${config.band.image}, ${config.style.background}`,
    amount: banded,
    shareOfSegmentBps: floorBps(BigInt(banded), amount) ?? 0,
    line: exchangeLinkedLine(row),
  };
}

// One mapping from a row to what's drawn, so nothing has per-segment markup. A row's entities are
// part of its segment, so a segment smaller than its own entities is refused. A missing amount
// throws, as BigInt can't read it.
export function supplySegments(
  row: SegmentRow,
  extras: SegmentExtras = {},
  config: SegmentConfig[] = SEGMENT_CONFIG,
): SupplySegment[] {
  const total = BigInt(row.total_supply);
  return config.map((segment) => {
    const { key, label, style, definition, circulating } = segment;
    const amount = BigInt(String(row[segment.key]));
    const { coverage, entities } = extras[segment.key] ?? {};
    const held = (entities ?? []).reduce((sum, entity) => sum + BigInt(entity.amount), 0n);
    if (held > amount) {
      throw new Error(`The rows named under ${segment.key} add up to more than the segment.`);
    }
    const band = bandOf(segment, row, amount);
    return {
      key,
      label,
      style,
      definition,
      circulating,
      amount: amount.toString(),
      shareBps: floorBps(amount, total),
      ...(coverage ? { coverage } : {}),
      ...(entities ? { entities } : {}),
      ...(band ? { band } : {}),
    };
  });
}

export function segmentLabel(segment: Pick<SupplySegment, "label" | "coverage">): string {
  return segment.coverage === "floor" ? `${segment.label}, at least` : segment.label;
}

// What's safe to send to a client component: a row's name reaches the page only as its row.
export function withoutEntities({ entities, ...segment }: SupplySegment): DrawnSegment {
  void entities;
  return segment;
}

// A segment under this share of its bar has no room for a label, so the legend beside it names it.
const LABEL_MIN_BPS = 2500;

// What the bar prints on a segment, if there's room.
export function directLabel(segment: Pick<SupplySegment, "label" | "coverage" | "shareBps">) {
  return (segment.shareBps ?? 0) >= LABEL_MIN_BPS
    ? `${segmentLabel(segment)} ${formatBps(segment.shareBps)}`
    : null;
}

// A floor in whole dollars, rounded down, as a compact figure can round up past what "at least" allows.
export function legendAmount(segment: Pick<SupplySegment, "amount" | "coverage">): string {
  return segment.coverage === "floor"
    ? formatFloorDollars(segment.amount)
    : formatCompact(segment.amount);
}

// The exchange venues segment is a floor on every panel. Its named rows add up across chains, so
// they go only where their sum can sit under the segment: the panel that covers every chain.
export function exchangeExtras(entities?: ExchangeRow[]): SegmentExtras {
  return { venue_exchange: { coverage: "floor", ...(entities ? { entities } : {}) } };
}

export type BarRow = {
  key: string;
  // Holds every amount the config reads. verify-output reads the band from it in the page's payload.
  journey: JourneyAmounts & Record<string, unknown>;
};

export type SupplyStat = { key: string; label: string; value: string };

export type SupplyPanel = {
  option: ChainOption;
  chains: ChainName[];
  rows: JourneyRow[];
  kpis: KpiRow[];
  heading: string;
  bar: BarRow | null;
  segments: SupplySegment[];
  notes: SegmentNote[];
  stats: SupplyStat[];
  table: {
    caption: string;
    columns: { key: string; label: string; numeric?: boolean }[];
    rows: Record<string, string>[];
  };
};

export type SupplyInputs = {
  journey: JourneyRow[];
  activity: ActivityRow[];
  kpis: KpiRow[];
  definitions: Definitions;
  exchanges: ExchangeRow[];
  config?: SegmentConfig[];
};

// Circulating comes from activity, and only from the day the journey row is from, so a figure beside
// a bar never belongs to another day.
function circulatingByChain(
  newest: JourneyRow[],
  activity: ActivityRow[],
): Map<ChainName, string | null> {
  const byDay = new Map(activity.map((row) => [`${row.chain}|${row.day}`, row.circulating_supply]));
  return new Map(newest.map((row) => [row.chain, byDay.get(`${row.chain}|${row.day}`) ?? null]));
}

// Each chain's newest day, summed for every amount the config reads, as well as the journey's own.
function allChainsBar(rows: JourneyRow[], config: SegmentConfig[]): BarRow | null {
  const all = allChainJourney(rows);
  if (!all) return null;
  const read = (row: JourneyRow, key: string) => (row as unknown as Record<string, string>)[key];
  const amounts = config.map((segment) => [
    segment.key,
    rows.reduce((sum, row) => sum + BigInt(read(row, segment.key)), 0n).toString(),
  ]);
  return { key: "all", journey: { ...all, ...Object.fromEntries(amounts) } };
}

function summed(values: (string | null | undefined)[]): string | null {
  if (values.length === 0 || values.some((value) => value === null || value === undefined)) {
    return null;
  }
  return values.reduce((sum, value) => sum + BigInt(value!), 0n).toString();
}

function panelTable(
  rows: JourneyRow[],
  circulating: Map<ChainName, string | null>,
  config: SegmentConfig[],
  extras: SegmentExtras,
): SupplyPanel["table"] {
  const named = supplyColumns(config, extras);
  return {
    caption: "Supply by part, newest day per chain. Holders are wallets, not people.",
    columns: [
      { key: "chain", label: "Chain" },
      { key: "day", label: "Day" },
      { key: "total", label: "Total", numeric: true },
      ...named.map(({ key, label }) => ({ key, label, numeric: true })),
      { key: "circulating", label: "Circulating", numeric: true },
      { key: "holders", label: "Holders", numeric: true },
      { key: "large", label: "Holders of $1M or more", numeric: true },
      { key: "top10", label: "Top-10 share of supply", numeric: true },
    ],
    rows: rows.map((row) => ({
      chain: CHAIN_NAMES[row.chain],
      day: formatUtcDate(row.day),
      total: formatExact(row.total_supply),
      ...Object.fromEntries(
        named.map(({ key, read }) => [
          key,
          formatExact(String((row as unknown as Record<string, unknown>)[read])),
        ]),
      ),
      circulating: formatExact(circulating.get(row.chain)),
      holders: row.holders.toLocaleString("en-US"),
      large: row.holders_over_1m.toLocaleString("en-US"),
      top10: formatBps(top10ShareBps(row)),
    })),
  };
}

// A column per segment, and one for its band, so a segment in the config is in the table too.
function supplyColumns(config: SegmentConfig[], extras: SegmentExtras) {
  return config.flatMap((segment) => [
    {
      key: segment.key,
      read: segment.key,
      label: segmentLabel({ label: segment.label, coverage: extras[segment.key]?.coverage }),
    },
    ...(segment.band
      ? [
          {
            key: segment.band.key,
            read: segment.band.key,
            label: `Of ${segment.label.toLowerCase()}, exchange-linked`,
          },
        ]
      : []),
  ]);
}

// Everything one filter option's supply card shows, for the view and for verify-output alike.
export function supplyPanel(
  option: ChainOption,
  { journey, activity, kpis, definitions, exchanges, config = SEGMENT_CONFIG }: SupplyInputs,
): SupplyPanel {
  const rows = newestByChain(journey).filter((row) => option.chains.includes(row.chain));
  const own = newestByChain(kpis).filter((row) => option.chains.includes(row.chain));
  const circulating = circulatingByChain(rows, activity);
  const extras = exchangeExtras(option.value === "all" ? exchanges : undefined);
  const bar =
    option.value === "all"
      ? allChainsBar(rows, config)
      : rows[0] && { key: rows[0].chain, journey: rows[0] };
  const notes = [
    ...config.flatMap((segment) =>
      (segment.notes?.({ rows }) ?? []).map((note) => ({ ...note, segment: segment.key })),
    ),
    { kind: "wallets-not-people", text: WALLETS_NOTE, tip: WALLETS_TABLE_NOTE },
  ];
  return {
    option,
    chains: option.chains,
    rows,
    kpis: own,
    heading: journeyHeading(rows, definitions),
    bar: bar ?? null,
    segments: bar ? supplySegments(bar.journey, extras, config) : [],
    notes,
    stats: [
      {
        key: "circulating",
        label: "Circulating",
        value: formatCompact(summed(rows.map((row) => circulating.get(row.chain)))),
      },
      {
        key: "clean-7d",
        label: "Clean volume, 7 days",
        value: formatCompact(summed(own.map((row) => row.clean_7d))),
      },
      // No total across chains, as the same address on three EVM chains would count three times.
      ...(option.value !== "all"
        ? [
            {
              key: "active-wallets",
              label: "Active wallets, 7 days",
              value: own[0]?.active_wallets_7d.toLocaleString("en-US") ?? UNKNOWN_TEXT,
            },
          ]
        : []),
    ],
    table: panelTable(rows, circulating, config, extras),
  };
}

export type SeriesPoint = {
  day: string;
  total_supply: string;
  placed_supply: string;
  circulating_supply: string;
};

// Only days every chain of the option has, from the first day placed supply can be known.
export function seriesFor(
  { journey, activity, definitions }: Pick<SupplyInputs, "journey" | "activity" | "definitions">,
  chains: ChainName[],
): SeriesPoint[] {
  const base = allChainSeries(journey, chains, ["total_supply", "placed_supply"]);
  const circulating = new Map(
    allChainSeries(activity, chains, ["circulating_supply"]).map((point) => [
      point.day,
      point.circulating_supply,
    ]),
  );
  return base
    .filter((point) => point.day >= definitions.journey_first_day && circulating.has(point.day))
    .map((point) => ({ ...point, circulating_supply: circulating.get(point.day)! }));
}

// Everything one filter option's step line shows, for the view and for verify-output alike.
export function seriesPanel(option: ChainOption, inputs: Parameters<typeof seriesFor>[0]) {
  const series = seriesFor(inputs, option.chains);
  return {
    option,
    series,
    heading: seriesHeading(series, option.chains),
    notes: [
      {
        kind: "series-start",
        text: seriesStartPin(inputs.definitions),
        tip: seriesStartNote(inputs.definitions),
      },
    ],
    latest: series.length > 0 ? series[series.length - 1] : null,
    tableRows: series.map((point) => ({
      day: formatUtcDate(point.day),
      total: formatExact(point.total_supply),
      placed: formatExact(point.placed_supply),
      circulating: formatExact(point.circulating_supply),
    })),
  };
}
