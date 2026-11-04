// Local only, and never run by `make check`. Serves each built state on localhost and captures it
// with headless Playwright, so a screenshot can't hold a terminal, browser chrome or a local path.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_DIR = join(WEB_DIR, ".shots");
const WIDTHS = [320, 390, 768, 1056, 1440];
const HEIGHT = 900;
const STATES = [{ name: "placeholder", dir: join(WEB_DIR, "out") }];
const PAGES = [{ name: "home", path: "/" }];
const CONTENT_TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".woff2": "font/woff2",
};

function serve(root) {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
    const file = join(root, relative, pathname.endsWith("/") ? "index.html" : "");
    if (!file.startsWith(root + sep) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "text/plain" });
    response.end(readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function launch() {
  try {
    return await chromium.launch();
  } catch (error) {
    if (!String(error).includes("Executable doesn't exist")) throw error;
    console.error(
      "The screenshot browser isn't installed. Download it once with: make web-browser",
    );
    process.exit(1);
  }
}

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
        await tab.close();
        console.log(`.shots/${name}`);
      }
    }
    server.close();
  }
} finally {
  await browser.close();
}
