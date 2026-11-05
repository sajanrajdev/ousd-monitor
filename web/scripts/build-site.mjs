// Builds the site, and verifies what it wrote. A bad dataset stops here, before Next starts.
//   build-site.mjs [name]    into .build/<name>, default "default"
//   build-site.mjs --release into .release/, moving .release/latest only after a verified build
// Only --release ever touches .release/, so a sample build can't overwrite the last good version.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatasetError, datasetFrom, loadDatasetFiles, locateDataset } from "../lib/dataset/load.ts";
import { expectedFromFiles, verifyOutput } from "./verify-output.mjs";

const WEB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const LATEST = "latest";

export class Refused extends Error {}

// Next writes out/, and the output is moved from there, so next.config.ts is the same for every
// build and a failed build leaves the target as it was.
function nextBuild(webRoot, target) {
  const out = join(webRoot, "out");
  rmSync(out, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [join(webRoot, "node_modules/next/dist/bin/next"), "build"],
    { cwd: webRoot, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } },
  );
  if (result.status !== 0) throw new Refused("next build failed.");
  rmSync(target, { recursive: true, force: true });
  renameSync(out, target);
}

function logWarnings(dataset, log) {
  for (const { chain, metric, day, previous, current } of dataset.manifest.warnings) {
    log(`Warning: ${chain} ${metric} on ${day} went from ${previous} to ${current}.`);
  }
}

function refuseUnlessVerified(outDir, expected) {
  const problems = verifyOutput(outDir, expected);
  if (problems.length > 0) {
    throw new Refused(`The output failed verification:\n${problems.join("\n")}`);
  }
}

export function buildSite({
  name,
  location,
  webRoot = WEB_DIR,
  log = console.log,
  build = nextBuild,
  now = Date.now,
}) {
  const { files, placement } = loadDatasetFiles(location, webRoot);
  const dataset = datasetFrom(files, placement, now());
  const expected = expectedFromFiles(files, placement, webRoot, now());
  logWarnings(dataset, log);
  const target = join(webRoot, ".build", name);
  mkdirSync(join(webRoot, ".build"), { recursive: true });
  build(webRoot, target);
  refuseUnlessVerified(target, expected);
  log(
    `Built and verified .build/${name}: ${dataset.state.kind}, ${dataset.manifest.dataset_version}.`,
  );
}

const WARNING_KEY = /^[a-z0-9_]+:[a-z0-9_]+$/;

// OUSD_ACK_WARNING_KEYS lists warnings known for review by chain and metric, so an unattended
// run can pass a known one on any day. Anything malformed is refused, never skipped.
export function acknowledgedKeys(env) {
  const raw = env.OUSD_ACK_WARNING_KEYS ?? "";
  const keys = raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  const malformed = keys.filter((key) => !WARNING_KEY.test(key));
  if (malformed.length > 0) {
    throw new Refused(
      `Refused: OUSD_ACK_WARNING_KEYS has entries that aren't chain:metric: ${malformed.join(", ")}.`,
    );
  }
  return new Set(keys);
}

export function refuseUnlessReleasable(dataset, env, log = () => {}) {
  const { state, manifest } = dataset;
  if (state.kind === "sample") throw new Refused("Refused: this is sample data, never a release.");
  if (state.kind === "preview") {
    throw new Refused(`Refused: this isn't release grade.\n${state.releaseProblems.join("\n")}`);
  }
  const keys = acknowledgedKeys(env);
  // Every run says what it lets through, so an acknowledgement can't sit there unseen.
  if (keys.size > 0) log(`Acknowledged warning keys: ${[...keys].join(", ")}.`);
  if (manifest.warnings.length === 0 || env.OUSD_ACK_WARNINGS === manifest.dataset_version) return;
  const unacknowledged = manifest.warnings.filter(
    ({ chain, metric }) => !keys.has(`${chain}:${metric}`),
  );
  if (unacknowledged.length > 0) {
    const named = [...new Set(unacknowledged.map(({ chain, metric }) => `${chain}:${metric}`))];
    throw new Refused(
      `Refused: this dataset has warnings for review that aren't acknowledged: ${named.join(", ")}. ` +
        `Read them above, then set OUSD_ACK_WARNINGS=${manifest.dataset_version} to go ahead.`,
    );
  }
  log(`Every warning is acknowledged by OUSD_ACK_WARNING_KEYS.`);
}

export function buildRelease({
  location,
  webRoot = WEB_DIR,
  releaseRoot = join(webRoot, ".release"),
  env = process.env,
  log = console.log,
  build = nextBuild,
  now = Date.now,
}) {
  // One read, before Next's, for the gate and the check. Pages built from a dataset swapped in since
  // then show another version or kind, and fail against this rather than agreeing with the swap.
  const { files, placement } = loadDatasetFiles(location, webRoot);
  const dataset = datasetFrom(files, placement, now());
  const expected = expectedFromFiles(files, placement, webRoot, now());
  logWarnings(dataset, log);
  refuseUnlessReleasable(dataset, env, log);
  mkdirSync(releaseRoot, { recursive: true });
  const folder = `${dataset.manifest.dataset_version}-${now()}`;
  const building = join(releaseRoot, `${folder}.tmp`);
  try {
    build(webRoot, building);
    refuseUnlessVerified(building, expected);
    renameSync(building, join(releaseRoot, folder));
  } catch (error) {
    rmSync(building, { recursive: true, force: true });
    throw error;
  }
  // One rename, so a reader sees the old version or the new one.
  const pointer = join(releaseRoot, `${LATEST}.tmp`);
  rmSync(pointer, { force: true });
  symlinkSync(folder, pointer);
  renameSync(pointer, join(releaseRoot, LATEST));
  for (const entry of readdirSync(releaseRoot)) {
    if (entry !== LATEST && entry !== folder) {
      rmSync(join(releaseRoot, entry), { recursive: true, force: true });
    }
  }
  log(`Released .release/${LATEST}: ${dataset.manifest.dataset_version}.`);
}

function main() {
  const [argument] = process.argv.slice(2);
  try {
    const location = locateDataset(process.env, WEB_DIR);
    if (location.origin === "sample-fallback" && existsSync(location.dir)) {
      console.log("No published dataset was found, so this build uses the sample.");
    }
    if (argument === "--release") {
      buildRelease({ location });
    } else {
      const name = argument ?? "default";
      if (!/^[a-z0-9-]+$/.test(name)) throw new Refused(`Not a build name: ${name}`);
      buildSite({ name, location });
    }
  } catch (error) {
    if (!(error instanceof DatasetError || error instanceof Refused)) throw error;
    console.error(
      error instanceof DatasetError ? `Dataset refused: ${error.message}` : error.message,
    );
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
