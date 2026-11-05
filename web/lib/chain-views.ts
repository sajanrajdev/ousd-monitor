// What the velocity chart and the chain grid show, for the views and for verify-output alike. Both
// compare chains, so neither is filtered: a filter option highlights its chain instead.
import { floorBps } from "./aggregate.ts";
import type { ChainName, ChainRoleRow, KpiRow, ManifestWarning } from "./dataset/rows.ts";
import { CHAIN_NAMES, REQUIRED_CHAINS } from "./definitions.ts";
import { formatBps, formatCompact, UNKNOWN_TEXT } from "./format.ts";
import { velocityWarnings } from "./takeaways/activity.ts";
import { VELOCITY_PIN } from "./takeaways/caveats.ts";
import { leadingSentence, orderedChains, type Measure } from "./takeaways/chain-roles.ts";

export const VELOCITY_MEASURES = [
  { key: "velocity_bps", label: "Velocity" },
  { key: "velocity_everyday_bps", label: "Everyday" },
  { key: "headline_velocity_bps", label: "Headline" },
] as const;

export type VelocityMeasure = (typeof VELOCITY_MEASURES)[number]["key"];

export type VelocityBar = {
  measure: VelocityMeasure;
  label: string;
  bps: number | null;
  // Of the chart's largest value, in basis points, floored. Null when there's no figure.
  widthBps: number | null;
  text: string;
};

export type VelocityGroup = { chain: ChainName; name: string; bars: VelocityBar[] };

export type VelocityNote = { kind: string; chain?: ChainName; text: string };

export type VelocityChart = {
  groups: VelocityGroup[];
  // Null when no chain has any figure, so there's nothing to draw.
  max: number | null;
  notes: VelocityNote[];
  // The warnings in full, for the popover.
  fullWarnings: { chain: ChainName; text: string }[];
};

const byChainOrder = <Row extends { chain: ChainName }>(rows: Row[]) =>
  [...rows].sort((a, b) => REQUIRED_CHAINS.indexOf(a.chain) - REQUIRED_CHAINS.indexOf(b.chain));

// A linear scale from zero to the largest figure on the chart. A zero scale draws nothing rather
// than dividing by it.
export function velocityChart(kpis: KpiRow[], warnings: ManifestWarning[]): VelocityChart {
  const rows = byChainOrder(kpis);
  const values = rows.flatMap((row) =>
    VELOCITY_MEASURES.map(({ key }) => row[key]).filter((bps): bps is number => bps !== null),
  );
  const max = values.length > 0 ? Math.max(...values) : null;
  const groups = rows.map((row) => ({
    chain: row.chain,
    name: CHAIN_NAMES[row.chain],
    bars: VELOCITY_MEASURES.map(({ key, label }) => {
      const bps = row[key];
      return {
        measure: key,
        label,
        bps,
        widthBps:
          bps === null || max === null
            ? null
            : max === 0
              ? 0
              : (floorBps(BigInt(bps), BigInt(max)) ?? 0),
        text: bps === null ? UNKNOWN_TEXT : formatBps(bps),
      };
    }),
  }));
  // Only for chains on the chart, in the chart's order, so a pin's number goes down the chart.
  const flagged = velocityWarnings(warnings).filter((warning) =>
    rows.some((row) => row.chain === warning.chain),
  );
  const ordered = byChainOrder(flagged);
  return {
    groups,
    max,
    notes: [
      ...ordered.map(({ chain, pin }) => ({ kind: "velocity-warning", chain, text: pin })),
      { kind: "velocity-denominators", text: VELOCITY_PIN },
    ],
    fullWarnings: ordered.map(({ chain, text }) => ({ chain, text })),
  };
}

// The grid's rows. A lead is measured on an amount, as the pipeline measures it, so each bar scales
// to that amount, and the lead marker and the longest bar can't disagree. Text is what the dataset
// gives: a share where it has one, and an amount otherwise.
export const GRID_MEASURES: {
  measure: Measure;
  label: string;
  amount: keyof ChainRoleRow;
  share?: keyof ChainRoleRow;
  showAmount: boolean;
}[] = [
  {
    measure: "supply",
    label: "Share of supply",
    amount: "total_supply",
    share: "supply_share_bps",
    showAmount: false,
  },
  { measure: "issuance", label: "Minted, 30 days", amount: "minted_30d", showAmount: true },
  {
    measure: "everyday",
    label: "Clean everyday, 30 days",
    amount: "clean_everyday_30d",
    share: "clean_everyday_share_bps",
    showAmount: true,
  },
  {
    measure: "dex_flow",
    label: "DEX flow, 30 days",
    amount: "dex_flow_30d",
    share: "dex_flow_share_bps",
    showAmount: true,
  },
  {
    measure: "lending_flow",
    label: "Lending flow, 30 days",
    amount: "lending_flow_30d",
    showAmount: true,
  },
];

export type GridCell = {
  chain: ChainName;
  text: string;
  widthBps: number;
  leads: boolean;
};

export type GridRow = { measure: Measure; label: string; lead: string; cells: GridCell[] };

export function chainGrid(roles: ChainRoleRow[]): { chains: ChainName[]; rows: GridRow[] } {
  const rows = orderedChains(roles);
  return {
    chains: rows.map((row) => row.chain),
    rows: GRID_MEASURES.map(({ measure, label, amount, share, showAmount }) => {
      const amounts = rows.map((row) => BigInt(row[amount] as string));
      const largest = amounts.reduce((top, value) => (value > top ? value : top), 0n);
      return {
        measure,
        label,
        lead: leadingSentence(measure),
        cells: rows.map((row, index) => {
          const shareText = share ? formatBps(row[share] as number | null) : null;
          const text = showAmount
            ? `${formatCompact(amounts[index])}${shareText ? ` (${shareText})` : ""}`
            : (shareText ?? formatCompact(amounts[index]));
          return {
            chain: row.chain,
            text,
            widthBps: largest > 0n ? (floorBps(amounts[index], largest) ?? 0) : 0,
            leads: row.leading_for.includes(measure),
          };
        }),
      };
    }),
  };
}
