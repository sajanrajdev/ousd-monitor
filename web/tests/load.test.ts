import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatasetError, isInside, loadDataset, locateDataset } from "@/lib/dataset/load";
import { generateTypes } from "@/scripts/generate-types.mjs";
import { at, copySample, editJson, tempDir, type Json } from "./dataset-helpers";

const SAMPLES = ["complete", "partial"] as const;

function failure(dir: string): string {
  try {
    loadDataset(at(dir));
  } catch (error) {
    expect(error).toBeInstanceOf(DatasetError);
    const { message } = error as DatasetError;
    // Never an absolute path, and never a row's contents.
    expect(message).not.toContain(dir);
    expect(message).not.toMatch(/\/(Users|home|tmp|var|private)\//);
    return message;
  }
  throw new Error("the load should have failed");
}

function editedFailure(
  file: string,
  change: (payload: Json) => void,
  sample: (typeof SAMPLES)[number] = "complete",
): string {
  const dir = copySample(sample);
  editJson(dir, file, change);
  return failure(dir);
}

describe("loading a sample", () => {
  it.each(SAMPLES)("%s loads and every file validates against the real schemas", (sample) => {
    const dataset = loadDataset({ dir: `fixtures/dataset/${sample}`, origin: "chosen" });
    expect(dataset.journey.length).toBeGreaterThan(0);
    expect(dataset.summary.kpis.length).toBeGreaterThan(0);
  });

  it("carries issuer_labeled, both denominators, labels and the legend through", () => {
    const { journey, summary, manifest, labels } = loadDataset(at(copySample("complete")));
    expect(journey.some((row) => row.issuer_labeled === false)).toBe(true);
    expect(summary.kpis.every((row) => typeof row.issuer_labeled === "boolean")).toBe(true);
    expect(manifest.definitions.velocity.velocity_bps.denominator).toBe("circulating_supply");
    expect(manifest.definitions.velocity.headline_velocity_bps.denominator).toBe("total_supply");
    expect(labels.data.every((row) => row.source_type && row.source_url)).toBe(true);
    expect(labels.unnamed_clusters.counts.length).toBeGreaterThan(0);
    expect(labels.source_legend.source_types.length).toBeGreaterThan(0);
  });

  it("leaves `detail` and `stale_reason` behind, so nothing can render them", () => {
    const dir = copySample("complete");
    editJson(dir, "manifest.json", (manifest) => {
      manifest.stale = true;
      manifest.stale_since = "2026-11-04T07:00:00Z";
      manifest.stale_reason = "chain_supply is failed";
    });
    const { manifest } = loadDataset(at(dir));
    expect(JSON.stringify(manifest)).not.toContain("chain_supply is failed");
    expect(JSON.stringify(manifest)).not.toContain("Sample check detail");
  });
});

describe("where the data comes from", () => {
  it("uses OUSD_DATASET_DIR first, and a missing one fails rather than falling back", () => {
    const dir = tempDir();
    const location = locateDataset({ OUSD_DATASET_DIR: join(dir, "nothing") });
    expect(location.origin).toBe("chosen");
    expect(() => loadDataset(location)).toThrow(/manifest\.json: file: is missing/);
  });

  it("falls back to the sample only when the published path doesn't exist", () => {
    const webRoot = join(tempDir(), "web");
    const location = locateDataset({}, webRoot);
    expect(location.origin).toBe("sample-fallback");
    expect(location.dir).toBe(join(webRoot, "fixtures/dataset/complete"));
  });
});

describe("the published path", () => {
  function published() {
    const root = tempDir();
    const webRoot = join(root, "web");
    mkdirSync(webRoot);
    mkdirSync(join(root, "data/published"), { recursive: true });
    return { webRoot, pointer: join(root, "data/published/latest") };
  }

  it("is used when it exists", () => {
    const { webRoot, pointer } = published();
    mkdirSync(pointer);
    expect(locateDataset({}, webRoot)).toEqual({ dir: pointer, origin: "published" });
  });

  it("fails rather than falling back to the sample when its pointer dangles", () => {
    const { webRoot, pointer } = published();
    symlinkSync("nothing-here", pointer);
    const location = locateDataset({}, webRoot);
    expect(location.origin).toBe("published");
    expect(() => loadDataset(location)).toThrow("manifest.json: file: is missing");
  });
});

describe("what counts as inside web/", () => {
  it("goes by path segment", () => {
    expect(isInside("/a/web", "/a/web")).toBe(true);
    expect(isInside("/a/web/fixtures/x", "/a/web")).toBe(true);
    expect(isInside("/a/web/..sample", "/a/web")).toBe(true);
    expect(isInside("/a/other", "/a/web")).toBe(false);
    expect(isInside("/a", "/a/web")).toBe(false);
  });
});

describe("a bad dataset fails the load, naming the file and field", () => {
  it("an amount as a float", () => {
    const message = editedFailure("journey.json", (payload) => {
      payload.data[0].total_supply = 1.5;
    });
    expect(message).toContain("journey.json");
    expect(message).toContain("/data/0/total_supply");
  });

  it("an amount as a number above 2^53", () => {
    const message = editedFailure("activity.json", (payload) => {
      payload.data[0].headline_value = 2 ** 53 + 2;
    });
    expect(message).toContain("activity.json");
    expect(message).toContain("/data/0/headline_value");
    expect(message).not.toContain(String(2 ** 53 + 2));
  });

  it("an extra field", () => {
    const message = editedFailure("summary.json", (payload) => {
      payload.kpis[0].surprise = "x";
    });
    expect(message).toContain("summary.json");
    expect(message).toContain('/kpis/0: has an unknown field "surprise"');
  });

  it("a missing field", () => {
    const message = editedFailure("journey.json", (payload) => {
      delete payload.data[0].issuer_labeled;
    });
    expect(message).toContain('/data/0: is missing "issuer_labeled"');
  });

  it("schema_version 2 on the manifest", () => {
    const message = editedFailure("manifest.json", (manifest) => {
      manifest.schema_version = 2;
    });
    expect(message).toBe("manifest.json: /schema_version: must be 1");
  });

  it("schema_version 2 on another file", () => {
    const message = editedFailure("labels.json", (payload) => {
      payload.schema_version = 2;
    });
    expect(message).toContain("labels.json");
    expect(message).toContain("/schema_version");
  });

  it("an unknown verdict.state", () => {
    const message = editedFailure("summary.json", (payload) => {
      payload.verdict.state = "thriving";
    });
    expect(message).toContain("summary.json");
    expect(message).toContain("/verdict/state");
    expect(message).not.toContain("thriving");
  });

  it("a missing file", () => {
    const dir = copySample("complete");
    rmSync(join(dir, "labels.json"));
    expect(failure(dir)).toBe("labels.json: file: is missing or can't be read");
  });

  it("a file left out of manifest.files", () => {
    const message = editedFailure("manifest.json", (manifest) => {
      delete manifest.files["journey.csv"];
    });
    expect(message).toBe("journey.csv: file: isn't in manifest.files");
  });

  it("an extra entry in manifest.files", () => {
    const message = editedFailure("manifest.json", (manifest) => {
      manifest.files["extra.json"] = { sha256: "0".repeat(64), rows: 0 };
    });
    expect(message).toContain('manifest.json: /files: has an unexpected entry "extra.json"');
  });

  it("a ../ name in manifest.files, which is never read", () => {
    const message = editedFailure("manifest.json", (manifest) => {
      manifest.files["../labels.json"] = { sha256: "0".repeat(64), rows: 0 };
    });
    expect(message).toContain('has an unexpected entry "../labels.json"');
  });

  it("a hash mismatch", () => {
    const dir = copySample("complete");
    writeFileSync(join(dir, "journey.csv"), `${readFileSync(join(dir, "journey.csv"))}\n`);
    expect(failure(dir)).toBe("journey.csv: sha256: doesn't match manifest.files");
  });

  it("a row count mismatch", () => {
    const message = editedFailure("manifest.json", (manifest) => {
      manifest.files["activity.json"].rows += 1;
    });
    expect(message).toBe("activity.json: rows: doesn't match manifest.files");
  });

  it("a CSV row count mismatch", () => {
    const message = editedFailure("manifest.json", (manifest) => {
      manifest.files["journey.csv"].rows -= 1;
    });
    expect(message).toBe("journey.csv: rows: doesn't match manifest.files");
  });

  it("files disagreeing on preview", () => {
    const message = editedFailure(
      "labels.json",
      (payload) => {
        payload.preview = false;
      },
      "partial",
    );
    expect(message).toBe("labels.json: /preview: disagrees with manifest.json");
  });

  it("a journey sum off by one base unit", () => {
    const message = editedFailure("journey.json", (payload) => {
      const row = payload.data[0];
      row.free_floating = String(BigInt(row.free_floating) + 1n);
    });
    expect(message).toContain("journey.json: /data/0: parts don't add up to total_supply");
    expect(message).toContain("base, 2026-10-14");
  });

  it("a waterfall sum off by one base unit", () => {
    const message = editedFailure("activity.json", (payload) => {
      const row = payload.data[0];
      row.clean_everyday = String(BigInt(row.clean_everyday) + 1n);
    });
    expect(message).toContain("activity.json: /data/0: parts don't add up to headline_value");
  });

  it("a top-level null", () => {
    const dir = copySample("complete");
    writeFileSync(join(dir, "manifest.json"), "null");
    expect(failure(dir)).toBe("manifest.json: /: must be a JSON object");
  });

  it("a time that fits the pattern but isn't a real time", () => {
    const message = editedFailure("manifest.json", (manifest) => {
      manifest.coverage.last_transfer_at.base = "2026-13-45T00:00:00Z";
    });
    expect(message).toBe("manifest.json: /coverage/last_transfer_at/base: isn't a real time");
  });

  it("a day that doesn't exist, which Date.parse would roll on to March", () => {
    const message = editedFailure("manifest.json", (manifest) => {
      manifest.generated_at = "2026-02-30T00:00:00Z";
    });
    expect(message).toBe("manifest.json: /generated_at: isn't a real time");
  });

  it("invalid JSON, without quoting any of it", () => {
    const dir = copySample("complete");
    writeFileSync(join(dir, "manifest.json"), '{"secret-looking-content": ');
    const message = failure(dir);
    expect(message).toBe("manifest.json: file: isn't valid JSON");
  });
});

describe("generated types", () => {
  const schemas = join(process.cwd(), "../pipeline/ousd/schemas");

  it("equal what the real schemas generate", async () => {
    const committed = readFileSync("lib/dataset/types.generated.ts", "utf8");
    expect(await generateTypes(schemas)).toBe(committed);
  });

  it("drift when a schema changes", async () => {
    const dir = tempDir();
    cpSync(schemas, dir, { recursive: true });
    const path = join(dir, "journey.schema.json");
    const schema = JSON.parse(readFileSync(path, "utf8"));
    schema.properties.data.items.properties.new_column = { type: "string" };
    schema.properties.data.items.required.push("new_column");
    writeFileSync(path, JSON.stringify(schema));

    const committed = readFileSync("lib/dataset/types.generated.ts", "utf8");
    expect(await generateTypes(dir)).not.toBe(committed);
  });
});
