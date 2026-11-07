// Local only, and never run by `make check`. Serves each built state on localhost and captures it
// with headless Playwright, so a screenshot can't hold a terminal, browser chrome or a local path.
// Usage: shots.mjs, for both samples, or shots.mjs <built folder ...>, for each folder's first screen,
// views, an open tooltip, the footer and /reconciliation/ at 1440 and 390, as the way to capture a
// real dataset.
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
  ["tooltip", ".chart-card__head .tip__icon"],
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
const KPI_TRIGGER = '[data-section="kpi-row"] .tip__icon';

// What a reader sees before scrolling, then the same with one KPI's tooltip open, in the viewport.
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
    const openName = `first-screen-kpi-tooltip-${state}-${viewport.width}.png`;
    await tab.screenshot({ path: join(OUTPUT_DIR, openName) });
    console.log(`.shots/${openName}`);
    await tab.close();
  }
}

// The filter in use: the supply view under each option, with the header out of the crop.
async function captureFilterOptions(browser, origin, state) {
  const tab = await browser.newPage({ viewport: { width: 1440, height: HEIGHT } });
  await tab.goto(`${origin}/`, { waitUntil: "networkidle" });
  await tab.evaluate(() => document.fonts.ready);
  await tab.addStyleTag({
    content: ".site-header, .chain-filter { position: static !important; }",
  });
  const inputs = tab.locator(".chain-filter input");
  for (const value of await inputs.evaluateAll((all) => all.map((input) => input.value))) {
    await tab.locator(`.chain-filter input[value="${value}"]`).check({ force: true });
    await tab.locator(`#placed-vs-circulating [data-chain-panel="${value}"] svg`).first().waitFor();
    const name = `supply-${state}-${value}-1440.png`;
    await tab.locator('[data-section="view-a"]').screenshot({ path: join(OUTPUT_DIR, name) });
    console.log(`.shots/${name}`);
  }
  await tab.close();
}

// Each view, a note's tooltip open by keyboard focus over its card, the footer, and the detail page.
async function captureEvidence(browser, origin, state) {
  for (const viewport of FIRST_SCREENS) {
    const tab = await browser.newPage({ viewport });
    await tab.goto(`${origin}/`, { waitUntil: "networkidle" });
    await tab.evaluate(() => document.fonts.ready);
    await tab.waitForFunction(() => document.documentElement.dataset.tips === "on");
    await tab.addStyleTag({
      content: ".site-header, .chain-filter { position: static !important; }",
    });
    const shoot = async (name, locator) => {
      const file = `${name}-${state}-${viewport.width}.png`;
      await locator.screenshot({ path: join(OUTPUT_DIR, file) });
      console.log(`.shots/${file}`);
    };
    for (const view of ["view-a", "view-b", "view-e"]) {
      await shoot(view, tab.locator(`[data-section="${view}"]`));
    }
    // The viewport, not the card, as an open panel floats past the card's edge.
    const card = tab.locator("#where-supply-sits");
    await card.locator("[data-pinned-notes] .tip__trigger").nth(1).focus();
    const open = `tooltip-open-${state}-${viewport.width}.png`;
    await tab.screenshot({ path: join(OUTPUT_DIR, open) });
    console.log(`.shots/${open}`);
    await tab.evaluate(() => document.activeElement?.blur());
    const footer = tab.locator("footer");
    await footer.locator("[data-reconciled] a, [data-footer-status] a").first().hover();
    await tab.waitForTimeout(400);
    // In page coordinates, with room above for the status's tooltip.
    const box = await footer.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top + window.scrollY, height: rect.height };
    });
    const file = `footer-${state}-${viewport.width}.png`;
    await tab.screenshot({
      path: join(OUTPUT_DIR, file),
      fullPage: true,
      clip: { x: 0, y: box.top - 80, width: viewport.width, height: box.height + 80 },
    });
    console.log(`.shots/${file}`);
    await tab.goto(`${origin}/reconciliation/`, { waitUntil: "networkidle" });
    await tab.evaluate(() => document.fonts.ready);
    const page = `reconciliation-${state}-${viewport.width}.png`;
    await tab.screenshot({ path: join(OUTPUT_DIR, page), fullPage: true });
    console.log(`.shots/${page}`);
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
    await captureEvidence(browser, origin, basename(folder));
    server.close();
  }
  for (const state of folders.length === 0 ? STATES : []) {
    const server = await serve(state.dir);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await captureFirstScreen(browser, origin, state.name);
    await captureFilterOptions(browser, origin, state.name);
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
          // The same card with what it holds on demand: its tooltip, then its table.
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
