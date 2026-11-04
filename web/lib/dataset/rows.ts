// Names for the generated types, so nothing else spells out a path through a schema.
import type {
  ActivityFile,
  ChainRolesFile,
  JourneyFile,
  LabelsFile,
  ManifestFile,
  ReconciliationFile,
  SummaryFile,
} from "./types.generated.ts";

export type Verdict = SummaryFile["verdict"];
export type KnownLimit = SummaryFile["known_limits"][number];
export type KpiRow = SummaryFile["kpis"][number];
export type JourneyRow = JourneyFile["data"][number];
export type ActivityRow = ActivityFile["data"][number];
export type ChainRoleRow = ChainRolesFile["data"][number];
export type ReconciliationRow = ReconciliationFile["data"][number];
export type LatestRun = ReconciliationFile["latest_run"];
export type LabelRow = LabelsFile["data"][number];
export type ChainName = KpiRow["chain"];
export type Definitions = ManifestFile["definitions"];
export type Coverage = ManifestFile["coverage"];
export type ManifestWarning = ManifestFile["warnings"][number];

// Pipeline strings that aren't reader copy leave here: `detail` and `stale_reason` never reach a
// page, so no component can render one by accident.
export type CheckRow = Omit<ManifestFile["checks"][number], "detail">;
export type Manifest = Omit<ManifestFile, "checks" | "stale_reason"> & { checks: CheckRow[] };

export type DatasetFiles = {
  manifest: ManifestFile;
  summary: SummaryFile;
  journey: JourneyFile;
  activity: ActivityFile;
  chain_roles: ChainRolesFile;
  reconciliation: ReconciliationFile;
  labels: LabelsFile;
};
