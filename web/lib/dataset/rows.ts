// Names for the generated types, so nothing else spells out a path through a schema.
import type {
  ActivityFile,
  ChainRolesFile,
  JourneyFile,
  LabelsFile,
  ManifestFile,
  ManifestV2File,
  ReconciliationFile,
  StaleFile,
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

// Either manifest a site reads. Version 2 carried its own stale state. Version 3 adds provenance,
// and a folder's stale state is in stale.json beside it, so a published file never changes.
export type AnyManifest = ManifestFile | ManifestV2File;
export type StaleMark = StaleFile;

// Pipeline strings that aren't reader copy leave here: `detail` and the stale reason never reach a
// page, so no component can render one by accident. Only fields both versions share go through.
export type CheckRow = Omit<ManifestFile["checks"][number], "detail">;
export type Manifest = Omit<AnyManifest, "checks"> & { checks: CheckRow[] };

export type DatasetFiles = {
  manifest: AnyManifest;
  // From stale.json, or else from a version 2 manifest. Null while the dataset is current.
  stale: StaleMark | null;
  summary: SummaryFile;
  journey: JourneyFile;
  activity: ActivityFile;
  chain_roles: ChainRolesFile;
  reconciliation: ReconciliationFile;
  labels: LabelsFile;
};
