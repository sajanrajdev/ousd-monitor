// Stops the web steps with a useful message before npx or pnpm can fail in a confusing way. It has
// no import guard, so it can't exit 0 without checking.
import { readFileSync } from "node:fs";
import { satisfies } from "./node-range.mjs";

const packageFile = new URL("../package.json", import.meta.url);
const range = JSON.parse(readFileSync(packageFile, "utf8")).engines.node;
if (!satisfies(process.version, range)) {
  console.error(`Node ${process.version} can't run the site. Install Node ${range}.`);
  process.exit(1);
}
