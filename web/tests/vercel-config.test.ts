import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOutputConfig,
  contentSecurityPolicy,
  inlineScriptSources,
  securityHeaders,
} from "@/scripts/vercel-config.ts";

const hashOf = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

function release(pages: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  for (const [path, html] of Object.entries(pages)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), html);
  }
  return dir;
}

describe("the deploy config", () => {
  it("hashes each inline script, in every page, once", () => {
    const dir = release({
      "index.html":
        '<script>self.a=1</script><script src="/a.js"></script><script>self.b=2</script>',
      "methodology/index.html": "<script>self.a=1</script>",
    });
    expect(inlineScriptSources(dir)).toEqual([hashOf("self.a=1"), hashOf("self.b=2")].sort());
  });

  it("hashes the text exactly, whitespace and all", () => {
    const dir = release({ "index.html": "<script>\n  self.a = 1;\n</script>" });
    expect(inlineScriptSources(dir)).toEqual([hashOf("\n  self.a = 1;\n")]);
  });

  it("skips an empty script, and a script with a src, which the 'self' source covers", () => {
    const dir = release({ "index.html": '<script></script><script async src="/x.js"></script>' });
    expect(inlineScriptSources(dir)).toEqual([]);
  });

  it.each([
    ["an onclick attribute", '<button onclick="go()">x</button>', "onclick="],
    ["an onload attribute, in any case", '<body ONLOAD = "go()">', "ONLOAD="],
    ["a javascript: href", '<a href="javascript:void(0)">x</a>', "javascript:"],
    ["an unquoted javascript: src", "<iframe src=javascript:go()>", "javascript:"],
  ])("fails the release on %s", (_name, html, found) => {
    const dir = release({ "methodology/index.html": html });
    expect(() => inlineScriptSources(dir)).toThrow(found);
    expect(() => buildOutputConfig(dir)).toThrow(/methodology\/index\.html/);
  });

  it("allows handler-like text in a script body, in prose and in plain attributes", () => {
    const dir = release({
      "index.html":
        '<script>el.onclick = f; const u = "javascript:x";</script><p>use onclick= and javascript: here</p><a href="/on=1" data-on="x">a</a>',
    });
    expect(inlineScriptSources(dir)).toHaveLength(1);
  });

  it("gives the same policy for the same release", () => {
    const dir = release({ "index.html": "<script>b()</script><script>a()</script>" });
    expect(securityHeaders(dir)).toEqual(securityHeaders(dir));
  });

  it("holds scripts to self and hashes, with no unsafe-inline, and frames to none", () => {
    const policy = contentSecurityPolicy([hashOf("x")]);
    const directive = (name: string) =>
      policy.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("script-src")).toBe(`script-src 'self' ${hashOf("x")}`);
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("script-src")).not.toContain("unsafe");
    expect(directive("script-src")).not.toContain("unsafe-eval");
  });

  it("sends the headers on every path and carries on to the files", () => {
    const dir = release({ "index.html": "<script>x()</script>" });
    const { version, routes } = buildOutputConfig(dir);
    expect(version).toBe(3);
    expect(routes).toHaveLength(1);
    expect(routes[0].src).toBe("/(.*)");
    expect(routes[0].continue).toBe(true);
    expect(routes[0].headers).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  });

  it("grants no browser feature to anyone", () => {
    const policy = securityHeaders(release({ "index.html": "" }))["Permissions-Policy"];
    const grants = policy.split(", ");
    expect(grants.length).toBeGreaterThan(10);
    for (const grant of grants) expect(grant).toMatch(/^[a-z-]+=\(\)$/);
    expect(grants).toContain("camera=()");
    expect(grants).toContain("geolocation=()");
  });
});
