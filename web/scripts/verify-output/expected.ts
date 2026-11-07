import type { ChainOption } from "../../lib/chain-scope.ts";
import type {
  ActivityRow,
  ChainName,
  DatasetFiles,
  JourneyRow,
  KpiRow,
} from "../../lib/dataset/index.ts";
import type { DatasetLocation } from "../../lib/dataset/load.ts";
import type { Placement } from "../../lib/dataset/state.ts";
import type { SegmentNote } from "../../lib/supply-segments.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDatasetFiles } from "../../lib/dataset/load.ts";
import { deriveState } from "../../lib/dataset/state.ts";
import { allChainKpis, newestByChain } from "../../lib/aggregate.ts";
import { chainOptions } from "../../lib/chain-scope.ts";
import { CHAIN_NAMES, REQUIRED_CHAINS, TOKEN_CONTRACTS } from "../../lib/definitions.ts";
import { chainExchangeRows, exchangeRows } from "../../lib/exchange-rows.ts";
import {
  formatBps,
  formatCompact,
  formatExact,
  formatFloorDollars,
  UNKNOWN_TEXT,
} from "../../lib/format.ts";
import {
  day0Scope,
  historyLabel,
  stepFigure,
  velocityWarnings,
  waterfall,
  weeklyEveryday,
} from "../../lib/takeaways/activity.ts";
import { waterfallPanel, weeklyPanel } from "../../lib/activity-panels.ts";
import {
  day0Pin,
  everydayNote,
  EXCHANGE_FLOOR_PIN,
  exchangeCoveragePin,
  historyPin,
  HOPS_NOTE,
  issuerUnlabeledNote,
  NO_SWAPS_NOTE,
  PLACED_NOTE,
  PLACED_PIN,
  seriesStartNote,
  seriesStartPin,
  SMALL_TICKET_PIN,
  VELOCITY_PIN,
  WALLETS_NOTE,
} from "../../lib/takeaways/caveats.ts";
import {
  directLabel,
  legendAmount,
  segmentLabel,
  seriesPanel,
  supplyPanel,
} from "../../lib/supply-segments.ts";
import { exchangeLinkedBands } from "../../lib/takeaways/journey.ts";
import { verdictSentence, verdictTextVisible } from "../../lib/verdict.ts";
import { KPIS } from "./main-page.ts";
import { velocityExpected } from "./velocity.ts";
import { gridExpected } from "./grid.ts";

// Each waterfall part summed straight from the rows, from Day 0, with no code the page uses, so a
// fault in the panel code can't set what the check expects.
const DAY_ZERO_TEXT = "2026-09-30";

const PART_FIELDS = [
  "headline_value",
  "minted",
  "burned",
  "fees",
  "fee_liquidity",
  "issuer_flows",
  "same_entity",
  "same_tx_netting",
  "dex_flow",
  "lending_flow",
  "clean_large",
  "clean_everyday",
] as const;

function sumsFromRows(rows: ActivityRow[], chains: ChainName[]) {
  const sums: Record<string, bigint> = Object.fromEntries(PART_FIELDS.map((field) => [field, 0n]));
  for (const row of rows) {
    if (row.day < DAY_ZERO_TEXT || !chains.includes(row.chain)) continue;
    for (const field of PART_FIELDS) sums[field] += BigInt(row[field]);
  }
  return Object.fromEntries(Object.entries(sums).map(([key, sum]) => [key, sum.toString()]));
}

// What the page must keep in view and what each says, from the same conditions and words the views
// use to show it. A kind on two cards is two instances, and each is required.
type EssentialNote = { kind: string; chain?: string; text: string; exact?: boolean };

function essentialNotes({
  manifest,
  summary,
  journey,
  activity,
}: Pick<DatasetFiles, "manifest" | "summary" | "journey" | "activity">): EssentialNote[] {
  const { definitions } = manifest;
  const rows = activity.data;
  const scope = day0Scope(rows, summary.kpis);
  return [
    { kind: "placed", text: PLACED_PIN, exact: true },
    { kind: "exchange-floor", text: EXCHANGE_FLOOR_PIN, exact: true },
    { kind: "series-start", text: seriesStartPin(definitions), exact: true },
    { kind: "small-ticket", text: SMALL_TICKET_PIN, exact: true },
    { kind: "everyday-meaning", text: everydayNote(definitions), exact: true },
    { kind: "velocity-denominators", text: VELOCITY_PIN, exact: true },
    { kind: "no-swaps", text: NO_SWAPS_NOTE },
    // On the supply card, whose wallet counts are in its tables. The velocity table's caption says it
    // there too, which checkVelocity holds.
    { kind: "wallets-not-people", text: WALLETS_NOTE, exact: true },
    ...(waterfall(rows) ? [{ kind: "hops", text: HOPS_NOTE, exact: true }] : []),
    ...(scope ? [{ kind: "day-0-scope", text: day0Pin(scope), exact: true }] : []),
    ...(weeklyEveryday(rows).length > 0
      ? [{ kind: "history", text: historyPin(historyLabel(rows)), exact: true }]
      : []),
    ...velocityWarnings(manifest.warnings)
      .filter(({ chain }) => summary.kpis.some((row) => row.chain === chain))
      .map(({ chain, pin }) => ({ kind: "velocity-warning", chain, text: pin, exact: true })),
    ...newestByChain(journey.data)
      .filter((row) => !row.issuer_labeled && BigInt(row.issuer_inventory) === 0n)
      .map(({ chain }) => ({
        kind: "issuer-unlabeled",
        chain,
        text: issuerUnlabeledNote(chain),
      })),
    ...newestByChain(journey.data)
      .filter((row) => BigInt(row.venue_exchange) === 0n)
      .map(({ chain }) => ({
        kind: "exchange-coverage",
        chain,
        text: exchangeCoveragePin(chain),
        exact: true,
      })),
  ];
}

// What the supply card's figures and wallet table must be, read straight from the KPI rows. Circulating
// is compared only when each chain's KPI row is from its newest journey day, as the card reads that day.
function kpiFigures(option: ChainOption, kpis: KpiRow[], journey: JourneyRow[]) {
  const own = newestByChain(kpis).filter((row) => option.chains.includes(row.chain));
  const days = new Map(newestByChain(journey).map((row) => [row.chain, row.day]));
  const sameDays = own.every((row) => days.get(row.chain) === row.day);
  const all = own.length > 0 ? allChainKpis(own) : null;
  return {
    fromKpis: {
      "clean-7d": formatCompact(all?.clean_7d),
      ...(sameDays ? { circulating: formatCompact(all?.circulating_supply) } : {}),
      ...(option.chains.length === 1
        ? { "active-wallets": own[0]?.active_wallets_7d.toLocaleString("en-US") ?? UNKNOWN_TEXT }
        : {}),
    },
    kpiRows: own.map((row) => ({
      chain: CHAIN_NAMES[row.chain],
      clean: `${formatCompact(row.clean_7d)} (${formatExact(row.clean_7d)})`,
      wallets: row.active_wallets_7d.toLocaleString("en-US"),
    })),
  };
}

// The supply parts a row holds, by the names the legend and table give them, read straight from the
// dataset so they don't depend on the page's supply code. Exchange venues are a floor.
type PartKey =
  | "issuer_inventory"
  | "placed_supply"
  | "placed_exchange_linked"
  | "venue_dex"
  | "venue_lending"
  | "venue_exchange"
  | "free_floating";
const ROW_PARTS: [PartKey, string][] = [
  ["issuer_inventory", "Issuer inventory"],
  ["placed_supply", "Placed"],
  ["placed_exchange_linked", "Of placed, exchange-linked"],
  ["venue_dex", "DEX venues"],
  ["venue_lending", "Lending venues"],
  ["venue_exchange", "Exchange venues, at least"],
  ["free_floating", "Free-floating"],
];

// What an option's legend and table must say, from each chain's newest journey row as written:
// summed over every chain on All, and one chain's own on a chain.
function rowFigures(option: ChainOption, journey: JourneyRow[]) {
  const rows = newestByChain(journey).filter((row) => option.chains.includes(row.chain));
  const sum = (key: PartKey) => rows.reduce((held, row) => held + BigInt(row[key]), 0n).toString();
  const legend = Object.fromEntries(
    ROW_PARTS.filter(([key]) => key !== "placed_exchange_linked").map(([key]) => [
      key,
      key === "venue_exchange" ? formatFloorDollars(sum(key)) : formatCompact(sum(key)),
    ]),
  );
  return {
    scope: option.value === "all" ? "every chain" : CHAIN_NAMES[option.value],
    legend: rows.length > 0 ? legend : {},
    band: rows.length > 0 ? formatCompact(sum("placed_exchange_linked")) : null,
    table: rows.map((row) => ({
      chain: CHAIN_NAMES[row.chain],
      cells: Object.fromEntries([
        ["Total", formatExact(row.total_supply)],
        ...ROW_PARTS.map(([key, label]) => [label, formatExact(row[key])]),
      ]),
    })),
  };
}

// What each filter option's supply card and step line must say, from the same functions the view uses.
function expectedPanels(files: DatasetFiles) {
  const { manifest, summary, journey, activity, labels } = files;
  const options = chainOptions(manifest.coverage.chains_included);
  const inputs = {
    journey: journey.data,
    activity: activity.data,
    kpis: summary.kpis,
    definitions: manifest.definitions,
    exchanges: exchangeRows(labels),
    chainExchanges: Object.fromEntries(
      manifest.coverage.chains_included.map((chain) => [chain, chainExchangeRows(labels, chain)]),
    ),
  };
  const activityInputs = {
    activity: activity.data,
    kpis: summary.kpis,
    definitions: manifest.definitions,
  };
  // The words in view, and the note in full in its tooltip, with its link's words after it.
  const noteWordsOf = ({ kind, chain, text, tip, link, segment }: SegmentNote) => ({
    kind,
    chain,
    at: segment,
    words: text,
    ...(tip ? { tip: link ? `${tip} ${link.text}.` : tip } : {}),
  });
  return {
    filter: options.map(({ value, label }) => ({ value, label })),
    supplyPanels: options.map((option) => {
      const panel = supplyPanel(option, inputs);
      // With no legend, a segment's note has no row, so its badge is by the title.
      const notes = panel.notes
        .map(noteWordsOf)
        .map((note) => (panel.bar ? note : { ...note, at: undefined }));
      return {
        value: option.value,
        heading: panel.heading,
        key: panel.bar?.key ?? null,
        total: panel.bar?.journey.total_supply ?? null,
        rowTotal: panel.bar ? formatCompact(panel.bar.journey.total_supply) : UNKNOWN_TEXT,
        parts: panel.segments.map((segment) => ({
          key: segment.key,
          label: segmentLabel(segment),
          amount: segment.amount,
          compact: legendAmount(segment),
          width: `${(segment.shareBps ?? 0) / 100}%`,
          share: formatBps(segment.shareBps),
          direct: directLabel(segment),
          floor: segment.coverage === "floor",
          band: segment.band?.amount ?? null,
          bandLine: segment.band?.line ?? null,
        })),
        stats: panel.stats,
        notes,
        table: panel.table,
        chains: option.chains.length,
        ...kpiFigures(option, summary.kpis, journey.data),
        placedNote: PLACED_NOTE,
        exchanges: panel.exchanges,
        fromRows: rowFigures(option, journey.data),
      };
    }),
    velocity: velocityExpected(summary.kpis, manifest.warnings),
    grid: gridExpected(files.chain_roles.data),
    waterfallPanels: options.map((option) => {
      const panel = waterfallPanel(option, activityInputs);
      return {
        value: option.value,
        sums: sumsFromRows(activity.data, option.chains),
        heading: panel.heading,
        steps: (panel.waterfall?.steps ?? []).map((step) => ({
          key: step.key,
          figure: stepFigure(step),
        })),
        notes: panel.notes.map(({ kind, text, step }) => ({ kind, words: text, at: step })),
        fullNotes: panel.fullNotes,
        stepRows: panel.steps.rows,
        periodRows: panel.periods.rows,
      };
    }),
    weeklyPanels: options.map((option) => {
      const panel = weeklyPanel(option, activityInputs);
      return {
        value: option.value,
        heading: panel.heading,
        bars: panel.weeks.map((week) => `${week.to}=${formatCompact(week.everyday)}`),
        amounts: panel.weeks.map((week) => week.everyday),
        notes: panel.notes.map(({ kind, text }) => ({ kind, words: text })),
        fullNotes: panel.fullNotes,
        rows: panel.table.rows,
      };
    }),
    seriesPanels: options.map((option) => {
      const panel = seriesPanel(option, inputs);
      return {
        value: option.value,
        heading: panel.heading,
        notes: panel.notes.map(noteWordsOf),
        fullNote: seriesStartNote(manifest.definitions),
        rows: panel.tableRows,
      };
    }),
  };
}

// In the row's order, with the same formats, so a value is held to the dataset too.
function expectedKpiValues(kpis: KpiRow[]) {
  const figures = allChainKpis(kpis);
  if (!figures) return Array(KPIS).fill(UNKNOWN_TEXT);
  return [
    formatCompact(figures.total_supply),
    formatBps(figures.placed_share_bps),
    formatCompact(figures.clean_everyday_7d),
    formatBps(figures.velocity_everyday_bps),
  ];
}

export function expectedFromDataset(
  location: DatasetLocation,
  webRoot: string = process.cwd(),
  now = Date.now(),
) {
  const { files, placement } = loadDatasetFiles(location, webRoot);
  return expectedFromFiles(files, placement, webRoot, now);
}

export function expectedFromFiles(
  files: DatasetFiles,
  placement: Placement,
  webRoot: string = process.cwd(),
  now = Date.now(),
) {
  const state = deriveState(files, placement, now);
  const {
    kind,
    frameWord,
    freshness,
    asOfLine,
    trustLine,
    passing,
    headStale,
    staleInFooter,
    runLine,
  } = state;
  const { manifest, summary } = files;
  const { verdict } = summary;
  return {
    kind,
    frameWord,
    freshness,
    asOfLine,
    trustLine,
    passing,
    headStale,
    staleInFooter,
    runLine,
    checkCount: files.manifest.checks.length,
    version: manifest.dataset_version,
    pipelineStrings: [
      ...manifest.checks.map((check) => check.detail),
      ...(files.stale ? [files.stale.stale_reason] : []),
    ],
    blockedNames: JSON.parse(readFileSync(join(webRoot, "scripts/blocked-names.json"), "utf8")),
    tokenContracts: TOKEN_CONTRACTS,
    verdict: {
      sentence: verdictSentence(verdict),
      text: verdict.text,
      textVisible: verdictTextVisible(verdict, state),
      items: [...verdict.facts, ...verdict.estimates, ...verdict.opinions],
    },
    // Named under the row only when a chain is missing.
    kpiScope: REQUIRED_CHAINS.every((chain) => summary.kpis.some((row) => row.chain === chain))
      ? null
      : `Across ${summary.kpis.map((row) => CHAIN_NAMES[row.chain]).join(", ")}.`,
    kpiValues: expectedKpiValues(summary.kpis),
    essentialNotes: essentialNotes(files),
    exchangeRows: exchangeRows(files.labels),
    ...expectedPanels(files),
    bands: exchangeLinkedBands(files.journey.data).map((band) => ({
      ...band,
      name: (CHAIN_NAMES as Record<string, string>)[band.key] ?? band.key,
      exact: formatExact(band.amount),
    })),
  };
}

// What the dataset says the built site must show. Inferred, so a field added to expectedFromFiles
// is typed in every check at once.
export type Expected = ReturnType<typeof expectedFromFiles>;
