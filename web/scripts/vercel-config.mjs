// Prints the Vercel Build Output config.json for a verified release folder, security headers
// included. Usage: vercel-config.mjs <release folder>. The headers are built in vercel-config.ts.
import { buildOutputConfig } from "./vercel-config.ts";

const [releaseDir] = process.argv.slice(2);
if (!releaseDir) {
  console.error("Usage: vercel-config.mjs <release folder>");
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(buildOutputConfig(releaseDir))}\n`);
