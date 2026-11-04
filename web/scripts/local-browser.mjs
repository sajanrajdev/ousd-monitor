// For the local scripts only, never `make check`: a built site on localhost, and the headless browser.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { chromium } from "playwright";

const CONTENT_TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".woff2": "font/woff2",
};

export function serve(root) {
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

export async function launch() {
  try {
    return await chromium.launch();
  } catch (error) {
    if (!String(error).includes("Executable doesn't exist")) throw error;
    console.error("The browser isn't installed. Download it once with: make web-browser");
    process.exit(1);
  }
}
