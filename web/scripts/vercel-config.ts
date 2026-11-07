// The Vercel Build Output config for a verified release: its version, and the security headers every
// response carries. The static export writes inline scripts (Next's bootstrap and the page's data),
// so the policy allows each by its hash, read from the release itself, and never 'unsafe-inline'
// for scripts. Usage: vercel-config.mjs <release folder>, which prints config.json.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// An inline script's text is raw up to its closing tag, which is the text the browser hashes.
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;

// What a script hash can't cover: an inline event handler attribute, or a javascript: URL. Under this
// policy the browser would block it, so the page would break without any build step noticing.
const INLINE_SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const EVENT_HANDLER_ATTRIBUTE = /<[a-z][^>]*?\s(on[a-z]+)\s*=/i;
const JAVASCRIPT_URL = /<[a-z][^>]*?\s[a-z:-]+\s*=\s*["']?\s*javascript:/i;

// Features a page could ask for, each granted to no origin.
const DENIED_FEATURES = [
  "accelerometer",
  "autoplay",
  "camera",
  "display-capture",
  "encrypted-media",
  "fullscreen",
  "geolocation",
  "gyroscope",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "picture-in-picture",
  "publickey-credentials-get",
  "screen-wake-lock",
  "usb",
  "xr-spatial-tracking",
];

function htmlFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFilesUnder(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

// Throws when a page holds script the policy would block and a hash can't allow.
export function assertNoInlineHandlers(html: string, path: string): void {
  const markup = html.replace(INLINE_SCRIPT_BLOCK, "");
  const handler = markup.match(EVENT_HANDLER_ATTRIBUTE);
  if (handler)
    throw new Error(`${path} has an inline event handler (${handler[1]}=), which the CSP blocks.`);
  if (JAVASCRIPT_URL.test(markup))
    throw new Error(`${path} has a javascript: URL, which the CSP blocks.`);
}

// Every inline script in the release's pages, as a CSP source, sorted so the same release always
// gives the same policy.
export function inlineScriptSources(releaseDir: string): string[] {
  const hashes = new Set<string>();
  for (const path of htmlFilesUnder(releaseDir)) {
    const html = readFileSync(path, "utf8");
    assertNoInlineHandlers(html, path);
    for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
      if (body.trim() === "") continue;
      hashes.add(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
    }
  }
  return [...hashes].sort();
}

// Styles stay 'unsafe-inline': the pages carry hundreds of data-driven style attributes, such as
// each bar's width, which a hash can't cover. Scripts are what a policy has to hold.
export function contentSecurityPolicy(scriptSources: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptSources.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function securityHeaders(releaseDir: string): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(inlineScriptSources(releaseDir)),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": DENIED_FEATURES.map((feature) => `${feature}=()`).join(", "),
  };
}

// The headers go on every path and the route carries on, so the files in static/ answer as before.
export function buildOutputConfig(releaseDir: string) {
  return {
    version: 3,
    routes: [{ src: "/(.*)", headers: securityHeaders(releaseDir), continue: true }],
  };
}
