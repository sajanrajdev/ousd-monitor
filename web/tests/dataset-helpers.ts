import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import type { DatasetLocation } from "@/lib/dataset/load";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ousd-dataset-"));
  made.push(dir);
  return dir;
}

// A copy outside web/, still a sample through its FIXTURE file and git_commit.
export function copySample(name: "complete" | "partial"): string {
  const dir = tempDir();
  cpSync(join(process.cwd(), "fixtures/dataset", name), dir, { recursive: true });
  return dir;
}

export function at(dir: string): DatasetLocation {
  return { dir, origin: "chosen" };
}

export function readJson(dir: string, file: string): Json {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

function rowsOf(file: string, payload: Json): number {
  return file === "summary.json" ? payload.kpis.length : payload.data.length;
}

export function refreshEntry(dir: string, file: string, rows: number): void {
  const manifest = readJson(dir, "manifest.json");
  const sha256 = createHash("sha256")
    .update(readFileSync(join(dir, file)))
    .digest("hex");
  manifest.files[file] = { sha256, rows };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

// Changes one JSON file and keeps its hash and row count right, so only the change is under test.
export function editJson(dir: string, file: string, change: (payload: Json) => void): void {
  const payload = readJson(dir, file);
  change(payload);
  writeFileSync(join(dir, file), JSON.stringify(payload));
  if (file !== "manifest.json") refreshEntry(dir, file, rowsOf(file, payload));
}

// What a release-grade dataset would be: the complete sample with its sample marks taken off.
export function releaseGrade(): string {
  const dir = copySample("complete");
  rmSync(join(dir, "FIXTURE"));
  editJson(dir, "manifest.json", (manifest) => {
    manifest.git_commit = "abc1234".padEnd(40, "0");
  });
  return dir;
}

// What publish writes beside a folder once a newer run fails. The folder's own files don't change.
export function markStale(dir: string, reason = "a check failed"): string {
  const mark = { stale_since: "2026-11-04T07:00:00Z", stale_reason: reason };
  writeFileSync(join(dir, "stale.json"), JSON.stringify(mark));
  return dir;
}

// A manifest as schema version 2 wrote it: no provenance, and its own stale fields.
export function asVersion2(manifest: Json, staleReason: string | null = null): void {
  delete manifest.provenance;
  manifest.schema_version = 2;
  manifest.stale = staleReason !== null;
  manifest.stale_since = staleReason === null ? null : "2026-11-04T07:00:00Z";
  manifest.stale_reason = staleReason;
}

export function plantFile(root: string, path: string, content: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
