// Local only, and never run by `make check`. Serves each built state on localhost and captures it
// with headless Playwright, so a screenshot can't hold a terminal, browser chrome or a local path.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
const browser = await launch();
try {
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR);
  for (const state of STATES) {
    const server = await serve(state.dir);
    const origin = `http://127.0.0.1:${server.address().port}`;
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
