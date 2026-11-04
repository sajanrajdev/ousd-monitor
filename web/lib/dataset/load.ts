// The one way into the dataset. Stops at the first failure, and an error names the
// dataset-relative file, the field and the rule, never a row's contents or an absolute path.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { JOURNEY_PARTS, WATERFALL_PARTS } from "../aggregate.ts";
import type {
  ActivityRow,
  ChainRoleRow,
  CheckRow,
  DatasetFiles,
  JourneyRow,
  LatestRun,
  Manifest,
  ReconciliationRow,
} from "./rows.ts";
import { deriveState, type DatasetOrigin, type DatasetState, type Placement } from "./state.ts";

const MANIFEST = "manifest.json";
const JSON_FILES = {
  "summary.json": "summary",
  "journey.json": "journey",
  "activity.json": "activity",
  "chain_roles.json": "chain_roles",
  "reconciliation.json": "reconciliation",
  "labels.json": "labels",
} as const;
const CSV_FILES = ["journey.csv", "activity.csv", "chain_roles.csv"];
// Compared with manifest.files exactly, so no name is ever read from the manifest.
const LISTED_FILES = [...Object.keys(JSON_FILES), ...CSV_FILES].sort();
const FIXTURE_FILE = "FIXTURE";
const SCHEMA_DIR = "../pipeline/ousd/schemas";
const DEFAULT_DIR = "../data/published/latest";
const SAMPLE_DIR = "fixtures/dataset/complete";
const MAX_ERRORS_SHOWN = 5;

export class DatasetError extends Error {
  constructor(file: string, field: string, rule: string) {
    super(`${file}: ${field}: ${rule}`);
    this.name = "DatasetError";
  }
}

export type Dataset = {
  manifest: Manifest;
  summary: DatasetFiles["summary"];
  journey: JourneyRow[];
  activity: ActivityRow[];
  chain_roles: ChainRoleRow[];
  reconciliation: ReconciliationRow[];
  latest_run: LatestRun;
  labels: DatasetFiles["labels"];
  state: DatasetState;
};

export type DatasetLocation = { dir: string; origin: DatasetOrigin };

// OUSD_DATASET_DIR, then the published path, then the sample. A chosen path that's missing fails in
// the load rather than falling back. So does a dangling pointer at the published path.
export function locateDataset(
  env: Record<string, string | undefined> = process.env,
  webRoot = process.cwd(),
): DatasetLocation {
  const chosen = env.OUSD_DATASET_DIR;
  if (chosen) return { dir: resolve(webRoot, chosen), origin: "chosen" };
  const published = resolve(webRoot, DEFAULT_DIR);
  if (lstatSync(published, { throwIfNoEntry: false }))
    return { dir: published, origin: "published" };
  return { dir: resolve(webRoot, SAMPLE_DIR), origin: "sample-fallback" };
}

function readBytes(dir: string, name: string): Buffer {
  try {
    return readFileSync(join(dir, name));
  } catch {
    throw new DatasetError(name, "file", "is missing or can't be read");
  }
}

function parseJson(name: string, bytes: Buffer): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString());
  } catch {
    throw new DatasetError(name, "file", "isn't valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DatasetError(name, "/", "must be a JSON object");
  }
  return parsed;
}

const validators = new Map<string, ValidateFunction>();

function validatorFor(schema: string, webRoot: string): ValidateFunction {
  const path = resolve(webRoot, SCHEMA_DIR, `${schema}.schema.json`);
  const known = validators.get(path);
  if (known) return known;
  // Strict mode rejects forms the schemas use on purpose, such as a type array with a pattern.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validator = ajv.compile(JSON.parse(readFileSync(path, "utf8")));
  validators.set(path, validator);
  return validator;
}

// The field and the rule only. Ajv's own values could carry row contents, so none are used, except
// a property's name, which is what a reader has to fix.
function describe(error: ErrorObject): string {
  const field = error.instancePath || "/";
  const { additionalProperty, missingProperty } = error.params as Record<string, string>;
  if (additionalProperty) return `${field}: has an unknown field "${additionalProperty}"`;
  if (missingProperty) return `${field}: is missing "${missingProperty}"`;
  return `${field}: ${error.message}`;
}

function validate(name: string, schema: string, payload: unknown, webRoot: string): void {
  const validator = validatorFor(schema, webRoot);
  if (validator(payload)) return;
  // `if` only says a branch failed, and that branch's own errors are also listed.
  const errors = (validator.errors ?? []).filter((error) => error.keyword !== "if");
  const shown = errors.slice(0, MAX_ERRORS_SHOWN).map(describe);
  const more = errors.length - shown.length;
  throw new DatasetError(
    name,
    "schema",
    `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`,
  );
}

function checkListedFiles(manifest: { files?: unknown }): void {
  const listed = Object.keys((manifest.files ?? {}) as object).sort();
  for (const name of listed) {
    if (!LISTED_FILES.includes(name)) {
      throw new DatasetError(MANIFEST, "/files", `has an unexpected entry ${JSON.stringify(name)}`);
    }
  }
  for (const name of LISTED_FILES) {
    if (!listed.includes(name)) throw new DatasetError(name, "file", "isn't in manifest.files");
  }
}

function rowCount(name: string, bytes: Buffer, payload: unknown): number | null {
  if (name.endsWith(".csv")) return bytes.toString().trimEnd().split("\n").length - 1;
  const { data, kpis } = payload as { data?: unknown; kpis?: unknown };
  const rows = name === "summary.json" ? kpis : data;
  return Array.isArray(rows) ? rows.length : null;
}

function addsUp(total: string | null, parts: string[]): boolean {
  return BigInt(total ?? 0) === parts.reduce((sum, part) => sum + BigInt(part), 0n);
}

function checkSums(files: DatasetFiles): void {
  files.journey.data.forEach((row, index) => {
    if (
      !addsUp(
        row.total_supply,
        JOURNEY_PARTS.map((part) => row[part]),
      )
    ) {
      throw new DatasetError(
        "journey.json",
        `/data/${index}`,
        `parts don't add up to total_supply on ${row.chain}, ${row.day}`,
      );
    }
  });
  files.activity.data.forEach((row, index) => {
    if (
      !addsUp(
        row.headline_value,
        WATERFALL_PARTS.map((part) => row[part]),
      )
    ) {
      throw new DatasetError(
        "activity.json",
        `/data/${index}`,
        `parts don't add up to headline_value on ${row.chain}, ${row.day}`,
      );
    }
  });
}

// A pattern can't tell Feb 30 from a real day, and Date.parse rolls it on to March, so the time has
// to come back unchanged. A time that doesn't can't be called fresh.
function isRealTime(time: string): boolean {
  const parsed = new Date(time);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().replace(".000Z", "Z") === time;
}

function checkTimes(manifest: DatasetFiles["manifest"]): void {
  const times: [string, string | undefined][] = [
    ["/generated_at", manifest.generated_at],
    ["/reconciliation/finished_at", manifest.reconciliation?.finished_at],
    ...Object.entries(manifest.coverage.last_transfer_at).map(([chain, time]): [string, string] => [
      `/coverage/last_transfer_at/${chain}`,
      time,
    ]),
  ];
  for (const [field, time] of times) {
    if (time !== undefined && !isRealTime(time)) {
      throw new DatasetError(MANIFEST, field, "isn't a real time");
    }
  }
}

// By path segment, so a folder named "..sample" under the root still counts as inside it.
export function isInside(path: string, root: string): boolean {
  const between = relative(root, path);
  if (between === ".." || between.startsWith(`..${sep}`)) return false;
  return !isAbsolute(between);
}

// Sample if the folder sits under web/, by the path given or the one a pointer resolves to.
function placementOf(location: DatasetLocation, webRoot: string): Placement {
  return {
    hasFixtureFile: existsSync(join(location.dir, FIXTURE_FILE)),
    underWeb:
      isInside(location.dir, webRoot) ||
      isInside(realpathSync(location.dir), realpathSync(webRoot)),
    origin: location.origin,
  };
}

export type LoadOptions = { webRoot?: string; now?: number };

export function loadDatasetFiles(
  location: DatasetLocation,
  webRoot = process.cwd(),
): { files: DatasetFiles; placement: Placement } {
  const { dir } = location;
  const manifest = parseJson(MANIFEST, readBytes(dir, MANIFEST)) as DatasetFiles["manifest"];
  if ((manifest as { schema_version?: unknown }).schema_version !== 1) {
    throw new DatasetError(MANIFEST, "/schema_version", "must be 1");
  }
  checkListedFiles(manifest);
  validate(MANIFEST, "manifest", manifest, webRoot);
  checkTimes(manifest);

  const payloads = new Map<string, unknown>();
  for (const name of LISTED_FILES) {
    const bytes = readBytes(dir, name);
    const { sha256, rows } = manifest.files[name];
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new DatasetError(name, "sha256", "doesn't match manifest.files");
    }
    const payload = name.endsWith(".json") ? parseJson(name, bytes) : null;
    if (rowCount(name, bytes, payload) !== rows) {
      throw new DatasetError(name, "rows", "doesn't match manifest.files");
    }
    payloads.set(name, payload);
  }
  for (const [name, schema] of Object.entries(JSON_FILES)) {
    validate(name, schema, payloads.get(name), webRoot);
  }

  const files = {
    manifest,
    summary: payloads.get("summary.json"),
    journey: payloads.get("journey.json"),
    activity: payloads.get("activity.json"),
    chain_roles: payloads.get("chain_roles.json"),
    reconciliation: payloads.get("reconciliation.json"),
    labels: payloads.get("labels.json"),
  } as DatasetFiles;
  for (const name of Object.keys(JSON_FILES)) {
    if ((payloads.get(name) as { preview: boolean }).preview !== manifest.preview) {
      throw new DatasetError(name, "/preview", "disagrees with manifest.json");
    }
  }
  checkSums(files);
  return { files, placement: placementOf(location, webRoot) };
}

// Pipeline strings that aren't reader copy stop here, so nothing downstream can render one.
function withoutPipelineStrings(manifest: DatasetFiles["manifest"]): Manifest {
  const checks: CheckRow[] = manifest.checks.map(({ name, status, blocking, checked_at }) => {
    return { name, status, blocking, checked_at };
  });
  const copy = { ...manifest, checks } as Manifest & { stale_reason?: string | null };
  delete copy.stale_reason;
  return copy;
}

export function loadDataset(location: DatasetLocation, options: LoadOptions = {}): Dataset {
  const { files, placement } = loadDatasetFiles(location, options.webRoot);
  return datasetFrom(files, placement, options.now);
}

export function datasetFrom(files: DatasetFiles, placement: Placement, now?: number): Dataset {
  return {
    manifest: withoutPipelineStrings(files.manifest),
    summary: files.summary,
    journey: files.journey.data,
    activity: files.activity.data,
    chain_roles: files.chain_roles.data,
    reconciliation: files.reconciliation.data,
    latest_run: files.reconciliation.latest_run,
    labels: files.labels,
    state: deriveState(files, placement, now ?? Date.now()),
  };
}
