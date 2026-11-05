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
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

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
  if (chosen !== undefined) {
    // Set but empty is a mistake, not a request for the default path.
    if (!chosen.trim()) throw new DatasetError("OUSD_DATASET_DIR", "value", "is set but empty");
    return { dir: resolve(webRoot, chosen), origin: "chosen" };
  }
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

// A name on the main page rests on a label, and its figures on the journey's own newest day.
function checkExchangeRows({ labels, journey }: DatasetFiles): void {
  const fail = (place: string, problem: string): never => {
    throw new DatasetError("labels.json", place, problem);
  };
  const newest = new Map<string, (typeof journey.data)[number]>();
  for (const row of journey.data) {
    const known = newest.get(row.chain);
    if (!known || row.day > known.day) newest.set(row.chain, row);
  }
  const exchangeLabels = labels.data.filter((row) => row.category === "exchange");
  const held = new Map<string, bigint>();
  labels.exchange_holdings.forEach((row, index) => {
    const place = `/exchange_holdings/${index}`;
    const named = exchangeLabels.filter((label) => label.entity === row.entity);
    if (named.length === 0) fail(place, `an exchange holding on ${row.chain} has no named label`);
    if (row.wallets > named.filter((label) => label.chain === row.chain).length) {
      fail(place, `an exchange holding on ${row.chain} has more wallets than labels`);
    }
    if (newest.get(row.chain)?.day !== row.day) {
      fail(place, `an exchange holding on ${row.chain} isn't from the journey's newest day`);
    }
    held.set(row.chain, (held.get(row.chain) ?? 0n) + BigInt(row.balance));
  });
  for (const [chain, row] of newest) {
    if ((held.get(chain) ?? 0n) !== BigInt(row.venue_exchange)) {
      fail("/exchange_holdings", `exchange holdings don't add up to exchange venues on ${chain}`);
    }
  }
  labels.data.forEach((row, index) => {
    if (row.category === "exchange_linked") {
      fail(`/data/${index}`, `an exchange-linked label on ${row.chain} has a name`);
    }
  });
  const other = new Set(
    labels.data.filter((row) => row.category !== "exchange").map((row) => row.entity),
  );
  labels.exchange_listings.forEach((row, index) => {
    if (other.has(row.entity)) {
      fail(
        `/exchange_listings/${index}`,
        "an exchange listing has the name of a label that isn't an exchange",
      );
    }
  });
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
    if (BigInt(row.placed_exchange_linked) > BigInt(row.placed_supply)) {
      throw new DatasetError(
        "journey.json",
        `/data/${index}`,
        `placed_exchange_linked is more than placed_supply on ${row.chain}, ${row.day}`,
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

// A pattern can't tell Feb 30 from a real day, and Date.parse rolls it on to March, so a time has to
// come back unchanged. Walks every value, so a new date field can't be missed.
function isRealTime(time: string): boolean {
  const parsed = new Date(time);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().replace(".000Z", "Z") === time;
}

function checkDates(name: string, value: unknown, field = ""): void {
  if (typeof value === "string") {
    if (TIME_SHAPE.test(value) && !isRealTime(value)) {
      throw new DatasetError(name, field, "isn't a real time");
    }
    if (DAY_SHAPE.test(value) && !isRealTime(`${value}T00:00:00Z`)) {
      throw new DatasetError(name, field, "isn't a real day");
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) checkDates(name, item, `${field}/${key}`);
  }
}

function countBy<Row>(rows: Row[], key: (row: Row) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return counts;
}

// The schemas can't say a value is unique across rows, and a repeated row would count a chain twice.
function checkOneRowEach({
  manifest,
  summary,
  chain_roles,
  journey,
  activity,
}: DatasetFiles): void {
  const included = manifest.coverage.chains_included as string[];
  const kpis = countBy(summary.kpis, (row) => row.chain);
  for (const chain of included) {
    const rows = kpis.get(chain) ?? 0;
    if (rows !== 1) {
      throw new DatasetError("summary.json", "/kpis", `${chain} is included, and has ${rows} rows`);
    }
  }
  for (const chain of kpis.keys()) {
    if (!included.includes(chain)) {
      throw new DatasetError("summary.json", "/kpis", `${chain} isn't in chains_included`);
    }
  }
  for (const [chain, rows] of countBy(chain_roles.data, (row) => row.chain)) {
    if (rows > 1) throw new DatasetError("chain_roles.json", "/data", `${chain} has ${rows} rows`);
  }
  for (const [name, data] of [
    ["journey.json", journey.data],
    ["activity.json", activity.data],
  ] as const) {
    const counted = countBy<{ chain: string; day: string }>(
      data,
      (row) => `${row.chain} ${row.day}`,
    );
    for (const [key, rows] of counted) {
      if (rows > 1) {
        const [chain, day] = key.split(" ");
        throw new DatasetError(name, "/data", `${chain} has ${rows} rows on ${day}`);
      }
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
  if ((manifest as { schema_version?: unknown }).schema_version !== 2) {
    throw new DatasetError(MANIFEST, "/schema_version", "must be 2");
  }
  checkListedFiles(manifest);
  validate(MANIFEST, "manifest", manifest, webRoot);
  checkDates(MANIFEST, manifest);

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
    checkDates(name, payloads.get(name));
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
  checkExchangeRows(files);
  checkOneRowEach(files);
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
