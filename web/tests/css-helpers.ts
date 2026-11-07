import { readFileSync } from "node:fs";
import { join } from "node:path";

export const globalsCss = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

// Splits the stylesheet at its @supports selector(:has(*)) block, matching braces, so a test can say
// what's inside it and what's anywhere else, before or after.
export function splitAtHasBlock(css: string): { inside: string; outside: string } {
  const start = css.indexOf("@supports selector(:has(*))");
  if (start === -1) throw new Error("no @supports selector(:has(*)) block");
  let depth = 0;
  let end = css.indexOf("{", start);
  do {
    if (css[end] === "{") depth += 1;
    if (css[end] === "}") depth -= 1;
    end += 1;
  } while (depth > 0);
  return { inside: css.slice(start, end), outside: css.slice(0, start) + css.slice(end) };
}
