import { existsSync } from "node:fs";
import { join } from "node:path";

// The two files browsers ask for, and the head links that name them. Next hashes the query string,
// so the links are matched by path.
const ICONS = [
  { file: "icon.svg", type: "image/svg+xml" },
  { file: "favicon.ico", type: "image/x-icon" },
];

export function checkFavicon(outDir: string, problems: string[]) {
  for (const { file } of ICONS) {
    if (!existsSync(join(outDir, file))) problems.push(`${file}: missing, so /${file} is a 404`);
  }
}

export function checkIconLinks(page: string, document: Document, problems: string[]) {
  const links = [...document.head.querySelectorAll("link[rel~='icon']")];
  for (const { file, type } of ICONS) {
    const found = links.some(
      (link) =>
        link.getAttribute("type") === type &&
        new RegExp(`^/${file.replace(".", "\\.")}(\\?|$)`).test(link.getAttribute("href") ?? ""),
    );
    if (!found) problems.push(`${page}: no icon link to /${file} in the head`);
  }
}
