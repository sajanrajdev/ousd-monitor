// Refreshes each sample's manifest after a sample file changes: every file's SHA-256 and row count.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLES = fileURLToPath(new URL("../fixtures/dataset", import.meta.url));

function rows(name, text) {
  if (name.endsWith(".csv")) return text.trimEnd().split("\n").length - 1;
  const parsed = JSON.parse(text);
  return name === "summary.json" ? parsed.kpis.length : parsed.data.length;
}

for (const sample of readdirSync(SAMPLES)) {
  const dir = join(SAMPLES, sample);
  const path = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const name of Object.keys(manifest.files)) {
    const bytes = readFileSync(join(dir, name));
    manifest.files[name] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      rows: rows(name, bytes.toString()),
    };
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`fixtures/dataset/${sample}/manifest.json`);
}
