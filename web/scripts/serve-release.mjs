// Local only. Serves a built folder on localhost with the security headers the deployed site sends,
// to look at it in a browser and read the console for policy violations.
// Usage: serve-release.mjs <built folder> [port]
import { resolve } from "node:path";
import { serve } from "./local-browser.mjs";

const [folder, port = "4173"] = process.argv.slice(2);
if (!folder) {
  console.error("Usage: serve-release.mjs <built folder> [port]");
  process.exit(2);
}
const server = await serve(resolve(folder), undefined, Number(port));
console.log(
  `Serving ${folder} with security headers on http://127.0.0.1:${server.address().port}/`,
);
