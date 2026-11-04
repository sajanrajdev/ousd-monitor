// Local only, and never run by `make check`. Serves each built state on localhost and captures it
// with headless Playwright, so a screenshot can't hold a terminal, browser chrome or a local path.
// Usage: shots.mjs, for both samples, or shots.mjs <built folder ...>, for only the first screen of
// each, which holds aggregates alone, as the way to capture a real dataset.
import { mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serve } from "./local-browser.mjs";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_DIR = join(WEB_DIR, ".shots");
const WIDTHS = [320, 390, 768, 1056, 1440];
const HEIGHT = 900;
const STATES = ["complete", "partial"].map((name) => ({
  name,
  dir: join(WEB_DIR, ".build", name),
}));
const OPEN_PARTS = [
  ["popover", ".info-popover > summary"],
  ["table", ".data-toggle > summary"],
];
const PAGES = [
  { name: "home", path: "/" },
  { name: "methodology", path: "/methodology/" },
];
const FIRST_SCREENS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const KPI_TRIGGER = '[data-section="kpi-row"] .info-popover > summary';

// What a reader sees before scrolling, then the same with one KPI's popover open, in the viewport.
async function captureFirstScreen(browser, origin, state) {
  for (const viewport of FIRST_SCREENS) {
    const tab = await browser.newPage({ viewport });
    await tab.goto(`${origin}/`, { waitUntil: "networkidle" });
    await tab.evaluate(() => document.fonts.ready);
    const name = `first-screen-${state}-${viewport.width}.png`;
    await tab.screenshot({ path: join(OUTPUT_DIR, name) });
    console.log(`.shots/${name}`);
    await tab.locator(KPI_TRIGGER).nth(1).click();
    await tab.mouse.move(0, 0);
    const openName = `first-screen-kpi-popover-${state}-${viewport.width}.png`;
    await tab.screenshot({ path: join(OUTPUT_DIR, openName) });
    console.log(`.shots/${openName}`);
    await tab.close();
  }
}

const folders = process.argv.slice(2).map((folder) => resolve(folder));
const browser = await launch();
try {
  if (folders.length === 0) rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const folder of folders) {
    const server = await serve(folder);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await captureFirstScreen(browser, origin, basename(folder));
    server.close();
  }
  for (const state of folders.length === 0 ? STATES : []) {
    const server = await serve(state.dir);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await captureFirstScreen(browser, origin, state.name);
    for (const page of PAGES) {
      for (const width of WIDTHS) {
        const tab = await browser.newPage({ viewport: { width, height: HEIGHT } });
        await tab.goto(origin + page.path, { waitUntil: "networkidle" });
        const name = `${page.name}-${state.name}-${width}.png`;
        await tab.screenshot({ path: join(OUTPUT_DIR, name), fullPage: true });
        console.log(`.shots/${name}`);
        // One card cropped alone, as it has to read as not real without the page around it.
        // A tall card scrolls while it's captured, so the sticky header would land across it.
        await tab.addStyleTag({ content: ".site-header { position: static; }" });
        const card = tab.locator(".chart-card").first();
        if ((await card.count()) > 0) {
          const cardName = `card-${state.name}-${width}.png`;
          await card.screenshot({ path: join(OUTPUT_DIR, cardName) });
          console.log(`.shots/${cardName}`);
          // The same card with what it holds on demand: its popover, then its table.
          for (const [part, trigger] of page.name === "home" ? OPEN_PARTS : []) {
            const opener = card.locator(trigger);
            await opener.click();
            await tab.mouse.move(0, 0);
            const openName = `card-${part}-${state.name}-${width}.png`;
            await card.screenshot({ path: join(OUTPUT_DIR, openName) });
            console.log(`.shots/${openName}`);
          }
        }
        await tab.close();
      }
    }
    server.close();
  }
} finally {
  await browser.close();
}
