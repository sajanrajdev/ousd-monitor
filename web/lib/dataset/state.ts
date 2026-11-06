// What a dataset is, from the dataset alone. No flag or argument can make a sample read as real.
import { dayRange } from "../aggregate.ts";
import { DEFAULT_DEFINITIONS, REQUIRED_CHAINS, CHECK_LABELS } from "../definitions.ts";
import {
  formatAsOf,
  formatUtcDate,
  formatUtcDateTime,
  UNKNOWN_TEXT,
  type AsOfRange,
} from "../format.ts";
import { FUTURE_SKEW_MS, isFreshAt, type FreshnessClock } from "./clock.ts";
import type { DatasetFiles } from "./rows.ts";

export { isFreshAt, type FreshnessClock };

// Architecture check 6. Applies to each of the three times, so two windows can't stack.
export const FRESHNESS_LIMIT_HOURS = 36;
const FRESHNESS_LIMIT_MS = FRESHNESS_LIMIT_HOURS * 60 * 60 * 1000;

const ZERO_COMMIT = /^0+$/;
const CHECK_NAMES = Object.keys(CHECK_LABELS);
const CHAIN_COUNT = REQUIRED_CHAINS.length;

export type DatasetKind = "sample" | "preview" | "real";
export type FrameWord = "Sample" | "Preview";
export type Freshness = "fresh" | "stale";
export type DatasetOrigin = "chosen" | "published" | "sample-fallback";

export type Placement = {
  hasFixtureFile: boolean;
  underWeb: boolean;
  origin: DatasetOrigin;
};

export type DatasetState = {
  kind: DatasetKind;
  // The word on every card and in the KPI row. Null only for a real dataset.
  frameWord: FrameWord | null;
  banner: { headline: string; details: string[] } | null;
  freshness: Freshness;
  clock: FreshnessClock;
  dataAsOf: AsOfRange | null;
  // Fresh text is null when a dataset is stale at build, as it can never become fresh again.
  asOfLine: { fresh: string | null; stale: string };
  // `short` is the footer's label once stale, with `stale` as its tooltip.
  trustLine: { fresh: string | null; stale: string; short: string };
  // Reconciled, and fresh when built. Only then does the footer say "Reconciled".
  passing: boolean;
  // Real data whose only fault is its age. The footer alone says it's old, so the top of each page
  // has no trust row or stale line. Sample, preview and a failed newer run keep theirs.
  staleInFooter: boolean;
  // The main page's as-of line once it's stale.
  headStale: string;
  // One line under the reconciliation page's title.
  runLine: { fresh: string | null; stale: string };
  // Why this isn't release grade, for a refusal. Empty only for a dataset fit to release.
  releaseProblems: string[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isFullPass(run: { scope: string; status: string | null } | null): boolean {
  return run !== null && run.scope === "full" && run.status === "pass";
}

function reconciliationProblems({ manifest, reconciliation }: DatasetFiles): string[] {
  const problems: string[] = [];
  const { latest_run: latest, data: rows } = reconciliation;
  if (!isFullPass(latest)) problems.push("latest_run isn't a full run that passed");
  if (!isFullPass(manifest.reconciliation)) {
    problems.push("manifest.reconciliation isn't a full run that passed");
  }
  if (latest && manifest.reconciliation && latest.run_id !== manifest.reconciliation.run_id) {
    problems.push("manifest.reconciliation and latest_run are different runs");
  }
  for (const chain of REQUIRED_CHAINS) {
    const passed = rows.filter(
      (row) => row.kind === "chain" && row.subject === chain && row.passed,
    );
    if (passed.length !== 1) {
      problems.push(`${chain} needs one passed chain row, and has ${passed.length}`);
    } else if (passed[0].run_id !== latest?.run_id) {
      problems.push(`${chain}'s chain row is from another run`);
    }
  }
  const bridge = rows.filter((row) => row.kind === "bridge" && row.passed);
  if (bridge.length !== 1) {
    problems.push(`Bridge needs one passed row, and has ${bridge.length}`);
  } else if (bridge[0].in_latest_run !== true) {
    problems.push("Bridge's row isn't in the latest run");
  }
  return problems;
}

// Nothing in a dataset can happen after it was written, beyond a little drift in a block's time.
function futureTimeProblems(manifest: DatasetFiles["manifest"]): string[] {
  const limit = Date.parse(manifest.generated_at) + FUTURE_SKEW_MS;
  const times: [string, string | undefined][] = [
    ["reconciliation.finished_at", manifest.reconciliation?.finished_at],
    ...Object.entries(manifest.coverage.last_transfer_at).map(([chain, time]): [string, string] => [
      `${chain}'s last_transfer_at`,
      time,
    ]),
  ];
  return times
    .filter(([, time]) => time !== undefined && Date.parse(time) > limit)
    .map(([name]) => `${name} is later than generated_at`);
}

// A release needs all of this. Anything else is preview, whatever the manifest calls itself.
export function releaseProblems(files: DatasetFiles): string[] {
  const { manifest, summary, journey, activity, chain_roles: roles } = files;
  const problems: string[] = [];
  if (manifest.preview) problems.push("the manifest says preview");
  if (!manifest.coverage.complete) problems.push("coverage isn't complete");
  for (const chain of REQUIRED_CHAINS) {
    if (!manifest.coverage.chains_included.includes(chain)) {
      problems.push(`${chain} isn't in chains_included`);
    }
    for (const [name, rows] of [
      ["journey", journey.data],
      ["activity", activity.data],
      ["chain_roles", roles.data],
    ] as const) {
      if (!rows.some((row) => row.chain === chain)) problems.push(`${chain} has no ${name} rows`);
    }
    if (!summary.verdict.scope.includes(chain)) {
      problems.push(`verdict.scope doesn't cover ${chain}`);
    }
    const kpiRows = summary.kpis.filter((row) => row.chain === chain).length;
    if (kpiRows !== 1) problems.push(`${chain} needs one KPI row, and has ${kpiRows}`);
  }
  problems.push(...futureTimeProblems(manifest));
  for (const name of CHECK_NAMES) {
    const found = manifest.checks.filter((check) => check.name === name);
    if (found.length !== 1) problems.push(`check ${name} appears ${found.length} times`);
    else if (found[0].status !== "passed") problems.push(`check ${name} is ${found[0].status}`);
  }
  if (manifest.checks.length !== CHECK_NAMES.length) {
    problems.push(`there aren't exactly ${CHECK_NAMES.length} checks`);
  }
  problems.push(...reconciliationProblems(files));
  if (canonical(manifest.definitions) !== canonical(DEFAULT_DEFINITIONS)) {
    problems.push("manifest.definitions differ from the documented defaults");
  }
  return problems;
}

export function isSample(manifest: DatasetFiles["manifest"], placement: Placement): boolean {
  return placement.hasFixtureFile || placement.underWeb || ZERO_COMMIT.test(manifest.git_commit);
}

// Fresh means all three kinds of time are within the limit, and none is ahead of the clock. Null
// when one is missing, so a dataset with no reconciliation can't be fresh.
export function freshnessClock(manifest: DatasetFiles["manifest"]): FreshnessClock {
  const generatedAt = manifest.generated_at;
  const finishedAt = manifest.reconciliation?.finished_at;
  if (!finishedAt) return { generatedAt, latestAt: null, freshUntil: null };
  const others = [finishedAt, ...Object.values(manifest.coverage.last_transfer_at)].map((time) =>
    Date.parse(time),
  );
  const oldest = Math.min(Date.parse(generatedAt), ...others);
  return {
    generatedAt,
    latestAt: new Date(Math.max(...others)).toISOString(),
    freshUntil: new Date(oldest + FRESHNESS_LIMIT_MS).toISOString(),
  };
}

function countsLine({ manifest }: DatasetFiles): string | null {
  const chains = manifest.coverage.chains_included.length;
  const notPassed = manifest.checks.filter((check) => check.status !== "passed").length;
  if (chains === CHAIN_COUNT && notPassed === 0) return null;
  const checks = notPassed === 1 ? "1 check" : `${notPassed} checks`;
  return `${chains} of ${CHAIN_COUNT} chains, ${checks} not passed.`;
}

function bannerFor(
  kind: DatasetKind,
  files: DatasetFiles,
  placement: Placement,
): DatasetState["banner"] {
  const counts = countsLine(files);
  if (kind === "sample") {
    const details = counts ? [counts] : [];
    if (placement.origin === "sample-fallback") {
      details.push("No published dataset was found, so this build shows the sample.");
    }
    return { headline: "Sample data. Nothing here is real.", details };
  }
  if (kind === "preview") {
    const detail =
      counts ??
      (reconciliationProblems(files).length > 0
        ? "Reconciliation evidence is missing."
        : "It doesn't meet the rules for a release.");
    return { headline: "Local preview. Not the published site.", details: [detail] };
  }
  return null;
}

export function deriveState(
  files: DatasetFiles,
  placement: Placement,
  nowMs: number,
): DatasetState {
  const { manifest, summary } = files;
  const problems = releaseProblems(files);
  const kind: DatasetKind = isSample(manifest, placement)
    ? "sample"
    : problems.length > 0
      ? "preview"
      : "real";
  const clock = freshnessClock(manifest);
  const freshness: Freshness = !manifest.stale && isFreshAt(clock, nowMs) ? "fresh" : "stale";
  const isFresh = freshness === "fresh";

  const dataTime = formatUtcDateTime(manifest.generated_at);
  const reason = manifest.stale
    ? "A newer run did not pass its checks."
    : "Nothing newer has reached this page, so it may be out of date.";
  const dataAsOf = dayRange(Object.values(summary.verdict.as_of));
  const reconciledAt = manifest.reconciliation?.finished_at;
  const reconciledTime = reconciledAt ? formatUtcDateTime(reconciledAt) : null;

  const passing = kind === "real" && isFresh;
  const staleInFooter = kind === "real" && !manifest.stale;
  const reconciledDay = reconciledAt
    ? formatUtcDate(reconciledAt).replace(/ \d{4} UTC$/, "")
    : UNKNOWN_TEXT;
  const asOfStale = manifest.stale
    ? `${reason} Data from ${dataTime}.`
    : `Data from ${dataTime}. Nothing newer has reached this page, so it may be out of date.`;

  return {
    kind,
    frameWord: kind === "sample" ? "Sample" : kind === "preview" ? "Preview" : null,
    banner: bannerFor(kind, files, placement),
    freshness,
    clock,
    dataAsOf,
    asOfLine: {
      fresh: isFresh ? (dataAsOf ? `Data as of ${formatAsOf(dataAsOf)}.` : UNKNOWN_TEXT) : null,
      stale: asOfStale,
    },
    // Never the reconciled sentence on sample or preview numbers, at any age.
    trustLine:
      kind === "real"
        ? {
            fresh: isFresh
              ? `Supply reconciled on all ${CHAIN_COUNT} chains as of ${reconciledTime}`
              : null,
            stale: `Last reconciled ${reconciledTime}. ${reason}`,
            short: `Last reconciled ${reconciledDay}`,
          }
        : { fresh: "Not reconciled", stale: "Not reconciled", short: "Not reconciled" },
    passing,
    staleInFooter,
    headStale: staleInFooter ? `Data from ${dataTime}.` : asOfStale,
    runLine:
      kind === "real"
        ? {
            fresh: isFresh ? `Last run ${reconciledTime}: every check passed.` : null,
            stale: manifest.stale
              ? `Last passing run ${reconciledTime}. ${reason}`
              : `Last run ${reconciledTime}: every check passed. ${reason}`,
          }
        : {
            fresh: `${kind === "sample" ? "Sample" : "Preview"} figures, not a reconciliation.`,
            stale: `${kind === "sample" ? "Sample" : "Preview"} figures, not a reconciliation.`,
          },
    releaseProblems: problems,
  };
}
