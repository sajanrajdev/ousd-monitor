// Runs on every build. Reads what was really written, and takes what to expect from the dataset, not
// from an argument, so no build can talk its way past it. Usage: verify-output.mjs <output folder>
// The checks are typed modules under verify-output/, one per view, and this is the entry point.
import { fileURLToPath } from "node:url";
import { locateDataset } from "../lib/dataset/load.ts";
import { expectedFromDataset, expectedFromFiles, verifyOutput } from "./verify-output/index.ts";

export { expectedFromDataset, expectedFromFiles, verifyOutput };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = verifyOutput(process.argv[2], expectedFromDataset(locateDataset()));
  for (const problem of problems) console.error(problem);
  process.exit(problems.length > 0 ? 1 : 0);
}
