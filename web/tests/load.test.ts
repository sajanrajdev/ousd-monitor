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

describe("an empty OUSD_DATASET_DIR", () => {
  it.each(["", "   "])("is set and wrong, not unset: %j", (value) => {
    expect(() => locateDataset({ OUSD_DATASET_DIR: value })).toThrow(
      "OUSD_DATASET_DIR: value: is set but empty",
    );
  });
});

describe("one row per chain", () => {
  it("refuses a chain with no KPI row", () => {
    const message = editedFailure("summary.json", (payload) => {
      payload.kpis = payload.kpis.filter((row: Json) => row.chain !== "solana");
    });
    expect(message).toBe("summary.json: /kpis: solana is included, and has 0 rows");
  });

  it("refuses a duplicated KPI row", () => {
    const message = editedFailure("summary.json", (payload) => {
      payload.kpis.push(payload.kpis[0]);
    });
    expect(message).toBe("summary.json: /kpis: tempo is included, and has 2 rows");
  });

  it("refuses a KPI row for a chain that isn't included", () => {
    const message = editedFailure(
      "summary.json",
      (payload) => {
        payload.kpis.push({ ...payload.kpis[0], chain: "base" });
      },
      "partial",
    );
    expect(message).toBe("summary.json: /kpis: base isn't in chains_included");
  });

  it("refuses a duplicated chain role", () => {
    const message = editedFailure("chain_roles.json", (payload) => {
      payload.data.push(payload.data[0]);
    });
    expect(message).toBe("chain_roles.json: /data: base has 2 rows");
  });

  it.each(["journey.json", "activity.json"])("refuses a duplicated day in %s", (file) => {
    const message = editedFailure(file, (payload) => {
      payload.data.push(payload.data[0]);
    });
    expect(message).toMatch(
      new RegExp(`^${file}: /data: base has 2 rows on \\d{4}-\\d{2}-\\d{2}$`),
    );
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

  it("schema_version 1 on the manifest", () => {
    const message = editedFailure("manifest.json", (manifest) => {
      manifest.schema_version = 1;
    });
    expect(message).toBe("manifest.json: /schema_version: must be 2");
  });

  it("schema_version 1 on another file", () => {
    const message = editedFailure("labels.json", (payload) => {
      payload.schema_version = 1;
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

  it("an exchange-linked amount larger than placed supply", () => {
    const message = editedFailure("journey.json", (payload) => {
      const row = payload.data[0];
      row.placed_exchange_linked = String(BigInt(row.placed_supply) + 1n);
    });
    expect(message).toContain("placed_exchange_linked is more than placed_supply");
  });

  it("an exchange holding with no named label", () => {
    const message = editedFailure("labels.json", (payload) => {
      payload.exchange_holdings[0].entity = "Nobody";
    });
    expect(message).toContain("/exchange_holdings/0");
  });

  it("exchange holdings that don't add up to exchange venues", () => {
    const message = editedFailure("labels.json", (payload) => {
      const row = payload.exchange_holdings[0];
      row.balance = String(BigInt(row.balance) + 1n);
    });
    expect(message).toContain("don't add up to exchange venues");
  });

  it("an exchange holding with more wallets than labels", () => {
    const message = editedFailure("labels.json", (payload) => {
      payload.exchange_holdings[0].wallets = 9;
    });
    expect(message).toContain("more wallets than labels");
  });

  it("an exchange holding from another day", () => {
    const message = editedFailure("labels.json", (payload) => {
      payload.exchange_holdings[0].day = "2026-10-01";
    });
    expect(message).toContain("newest day");
  });

  it("a negative exchange holding or exchange-linked amount", () => {
    const holding = editedFailure("labels.json", (payload) => {
      payload.exchange_holdings[0].balance = "-1";
    });
    expect(holding).toContain("/exchange_holdings/0/balance");
    const linked = editedFailure("journey.json", (payload) => {
      payload.data[0].placed_exchange_linked = "-1";
    });
    expect(linked).toContain("/placed_exchange_linked");
  });

  it("a named exchange-linked label", () => {
    const message = editedFailure("labels.json", (payload) => {
      payload.data[0].category = "exchange_linked";
    });
    expect(message).toMatch(/exchange-linked label|exchange holding|data\/0/);
  });

  it("an exchange listing with the name of a label that isn't an exchange", () => {
    const message = editedFailure("labels.json", (payload) => {
      const other = payload.data.find((row: Json) => row.category !== "exchange");
      payload.exchange_listings[0].entity = other.entity;
    });
    expect(message).toContain("/exchange_listings/0");
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

  it.each([
    ["journey.json", "/data/0/day", (p: Json) => (p.data[0].day = "2026-02-30")],
    ["activity.json", "/data/0/day", (p: Json) => (p.data[0].day = "2026-04-31")],
    ["summary.json", "/kpis/0/day", (p: Json) => (p.kpis[0].day = "2026-02-30")],
    ["summary.json", "/verdict/as_of/base", (p: Json) => (p.verdict.as_of.base = "2026-02-30")],
    ["chain_roles.json", "/data/0/as_of_day", (p: Json) => (p.data[0].as_of_day = "2026-02-30")],
    ["labels.json", "/data/0/date_checked", (p: Json) => (p.data[0].date_checked = "2026-02-30")],
  ])("a day that doesn't exist in %s, at %s", (file, field, change) => {
    expect(editedFailure(file, change)).toBe(`${file}: ${field}: isn't a real day`);
  });

  it("a time that doesn't exist in another file", () => {
    const message = editedFailure("reconciliation.json", (payload) => {
      payload.data[0].checked_at = "2026-02-30T00:00:00Z";
    });
    expect(message).toBe("reconciliation.json: /data/0/checked_at: isn't a real time");
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
