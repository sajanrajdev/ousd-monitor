import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { launch } from "../local-browser.mjs";
import { ALL_WIDTHS, WEB_DIR } from "./constants.ts";
import { checkFolder } from "./folder.ts";
import { loadHarness } from "./harness.ts";
import { counts, failures, notRun, seen, undeterminedContrast } from "./report.ts";

// Runs every check on each built folder, prints the results, and returns the exit code.
export async function run(args: string[]) {
  const widthsArg = args.find((arg) => arg.startsWith("--widths="));
  const widths = widthsArg
    ? widthsArg.slice("--widths=".length).split(",").map(Number)
    : ALL_WIDTHS;
  const folders = args.filter((arg) => !arg.startsWith("--")).map((folder) => resolve(folder));
  if (folders.length === 0) {
    folders.push(join(WEB_DIR, ".build/complete"), join(WEB_DIR, ".build/partial"));
  }
  for (const folder of folders) {
    if (!existsSync(join(folder, "index.html"))) {
      console.error(`No built site at ${basename(folder)}. Build it first, with: make web-samples`);
      process.exit(2);
    }
  }

  const harness = await loadHarness();
  const browser = await launch();
  try {
    for (const folder of folders) await checkFolder(browser, folder, harness, widths);
  } finally {
    await browser.close();
    await harness.close();
  }

  for (const [name, { pass, fail }] of counts)
    console.log(`${fail ? "FAIL" : "ok  "} ${pass}/${pass + fail} ${name}`);
  // Not a pass or a fail: what axe couldn't judge, such as text on the hatched fills.
  for (const line of undeterminedContrast) console.log(`Contrast axe couldn't judge, ${line}`);
  if (seen.realFolders === 0) notRun.add("the fold, as no folder holds real data");
  for (const reason of notRun) console.log(`Not run: ${reason}`);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.log(
    `${failures.length === 0 ? "Passed" : "Failed"}: ${counts.size} checks, ${failures.length} failures.`,
  );
  return failures.length > 0 ? 1 : 0;
}
