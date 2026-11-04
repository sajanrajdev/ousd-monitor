// Local only, and never run by `make check`. The one way the word and height budget is measured, the
// same for the baseline and the result: real dataset, JavaScript on, fonts loaded, filter on All,
// every toggle and popover closed. Words are main's innerText split on whitespace, leaving out
// .sr-only. Height is documentElement.scrollHeight. Usage: measure-page.mjs <built folder>
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";
import { launch, serve } from "./local-browser.mjs";

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

const folder = process.argv[2];
if (!folder) {
  console.error("Usage: measure-page.mjs <built folder>");
  process.exit(2);
}
const root = resolve(folder);

const server = await serve(root);
const browser = await launch();
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dataset = { version: null, kind: null };
  const measures = {};
  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const seen = await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = ".sr-only { display: none !important; }";
      document.head.append(style);
      const words = document.querySelector("main").innerText.split(/\s+/).filter(Boolean).length;
      style.remove();
      const root = document.documentElement;
      return {
        kind: root.dataset.datasetKind,
        version: root.dataset.datasetVersion,
        open: document.querySelectorAll("main details[open]").length,
        words,
        height: root.scrollHeight,
      };
    });
    Object.assign(dataset, { kind: seen.kind, version: seen.version });
    if (seen.open > 0) throw new Error(`${seen.open} panels were open, so this isn't the method.`);
    measures[`words_${viewport.width}`] = seen.words;
    measures[`height_${viewport.width}`] = seen.height;
    await page.close();
  }
  const html = readFileSync(join(root, "index.html"));
  console.log(
    JSON.stringify(
      { ...dataset, ...measures, index_html_bytes: html.length, gzipped: gzipSync(html).length },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.close();
}
