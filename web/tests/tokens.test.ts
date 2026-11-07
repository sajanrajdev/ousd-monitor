import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const tokensCss = readFileSync(join(root, "app/tokens.css"), "utf8");
const designSystem = readFileSync(join(root, "../docs/design-system.md"), "utf8");

function cssTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

// A markdown table row whose first cell is a backticked token. The value is the first backticked
// text in the second cell, and rows described in words (such as "maroon at 5%") have none.
function documentedTokens(markdown: string): Map<string, string | null> {
  const tokens = new Map<string, string | null>();
  for (const line of markdown.split("\n")) {
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    const name = cells[1]?.match(/^`(--[\w-]+)`$/)?.[1];
    if (!name) continue;
    tokens.set(name, cells[2]?.match(/`([^`]+)`/)?.[1] ?? null);
  }
  return tokens;
}

function resolve(value: string, tokens: Map<string, string>): string {
  const reference = value.match(/^var\((--[\w-]+)\)$/);
  return reference ? resolve(tokens.get(reference[1]) ?? value, tokens) : value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const HEX_COLOUR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;

function filesUnder(dir: string, extensions: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, extensions);
    return extensions.includes(extname(name)) ? [path] : [];
  });
}

describe("design tokens", () => {
  const css = cssTokens(tokensCss);
  const documented = documentedTokens(designSystem);

  it("has every token in the design system tables, with the same value", () => {
    expect(documented.size).toBeGreaterThan(40);
    for (const [name, value] of documented) {
      expect(css.has(name), `${name} is missing from tokens.css`).toBe(true);
      if (value !== null) {
        expect(resolve(css.get(name)!, css).toLowerCase(), name).toBe(value.toLowerCase());
      }
    }
  });

  it("has no token the design system doesn't document", () => {
    for (const name of css.keys()) {
      expect(documented.has(name), `${name} is not in docs/design-system.md`).toBe(true);
    }
  });

  it("gives body, meta, banner and signed text 4.5:1 on their surfaces", () => {
    const color = (name: string) => resolve(css.get(name)!, css);
    const pairs: [string, string][] = [
      ["--color-body-text", "--color-off-white"],
      ["--color-body-text", "--surface-card"],
      ["--color-meta-text", "--color-off-white"],
      ["--color-meta-text", "--surface-card"],
      ["--color-banner-text", "--color-banner-bg"],
      ["--meaning-positive", "--color-off-white"],
      ["--meaning-negative", "--color-off-white"],
    ];
    for (const [text, surface] of pairs) {
      expect(contrast(color(text), color(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("keeps ramp steps 3 and 4 below the 3:1 graphics limit, so they need the outline rule", () => {
    const offWhite = resolve(css.get("--color-off-white")!, css);
    expect(contrast(css.get("--ramp-3")!, offWhite)).toBeLessThan(3);
    expect(contrast(css.get("--ramp-4")!, offWhite)).toBeLessThan(3);
  });
});

describe("hex colour scan", () => {
  it("finds a planted hex colour", () => {
    expect(HEX_COLOUR.test('const fill = "#390922";')).toBe(true);
    expect(HEX_COLOUR.test('const fill = "var(--ramp-1)";')).toBe(false);
  });

  it("finds none in components or lib", () => {
    const files = [
      ...filesUnder(join(root, "components"), [".ts", ".tsx", ".css"]),
      ...filesUnder(join(root, "lib"), [".ts", ".tsx"]),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(HEX_COLOUR.test(readFileSync(file, "utf8")), file).toBe(false);
    }
  });
});

// Build output is left out wherever it sits. A leftover web/out mustn't fail the next check.
function assetsUnder(start: string): string[] {
  const skipped = new Set(["node_modules", ".next", "out", ".build", ".shots", ".release"]);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (skipped.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot)$/i.test(name)) {
        found.push(path.slice(start.length));
      }
    }
  };
  walk(start);
  return found;
}

describe("assets", () => {
  // The favicon is the one image the site ships: our own mark, drawn from the same geometry.
  const FAVICON_FILES = [join("/app", "favicon.ico"), join("/app", "icon.svg")];

  it("has no image, font or SVG file under web/ other than the Fontsource packages and the favicon", () => {
    expect(assetsUnder(root).sort()).toEqual(FAVICON_FILES);
  });

  it("draws the favicon from the header mark's geometry, in the palette's maroon and off-white", () => {
    const mark = readFileSync(join(root, "components/mark.tsx"), "utf8");
    const icon = readFileSync(join(root, "app/icon.svg"), "utf8");
    for (const shape of [/<rect [^>]*\/>/, /<path [^>]*\/>/]) {
      expect(icon.match(shape)?.[0].replace(/\s+/g, " ")).toBe(
        mark.match(shape)?.[0].replace(/\s+/g, " "),
      );
    }
    expect(icon).toContain('viewBox="0 0 24 24"');
    expect(icon).toContain('stroke="#390922"');
    expect(icon).toMatch(/prefers-color-scheme: dark[^}]*stroke: #f3e9e3/);
    expect(icon).not.toMatch(/data:|<image|<text/);
  });

  it("isn't caught out by a leftover web/out, and still finds a real asset", () => {
    const planted = mkdtempSync(join(tmpdir(), "ousd-assets-"));
    try {
      mkdirSync(join(planted, "out/_next/static/media"), { recursive: true });
      writeFileSync(join(planted, "out/_next/static/media/font.woff2"), "x");
      expect(assetsUnder(planted)).toEqual([]);
      mkdirSync(join(planted, "public"));
      writeFileSync(join(planted, "public/logo.png"), "x");
      expect(assetsUnder(planted)).toEqual([join("/public", "logo.png")]);
    } finally {
      rmSync(planted, { recursive: true, force: true });
    }
  });

  it("draws our mark inline, with no Open Standard artwork", () => {
    const mark = readFileSync(join(root, "components/mark.tsx"), "utf8");
    expect(mark).toContain("<svg");
    expect(mark).not.toMatch(/globe|season/i);
  });
});
