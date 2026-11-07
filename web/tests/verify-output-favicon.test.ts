import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyOutput } from "@/scripts/verify-output.mjs";
import { ICON_LINKS } from "./planted-first-screen";
import { MAIN, page, sampleExpected, site } from "./verify-output-fixture";

describe("the favicon in the output", () => {
  it("passes a site with both icon files and a link to each in every head", () => {
    expect(verifyOutput(site(), sampleExpected)).toEqual([]);
  });

  it.each(["favicon.ico", "icon.svg"])("fails with no %s in the build", (file) => {
    const dir = site();
    rmSync(join(dir, file));
    expect(verifyOutput(dir, sampleExpected)).toContain(`${file}: missing, so /${file} is a 404`);
  });

  it.each([
    ["the svg icon", /<link rel="icon"[^>]*icon\.svg[^>]*\/>/, "/icon.svg"],
    ["the ico fallback", /<link rel="icon"[^>]*favicon\.ico[^>]*\/>/, "/favicon.ico"],
  ])("fails on the page that lost %s, and only that page", (_name, link, target) => {
    const without = page(MAIN).replace(ICON_LINKS, (all) => all.replace(link, ""));
    expect(without).not.toBe(page(MAIN));
    const problems = verifyOutput(site({ main: without }), sampleExpected);
    expect(problems).toContain(`index.html: no icon link to ${target} in the head`);
    expect(problems.filter((problem) => problem.startsWith("methodology/"))).toEqual([]);
  });

  it("fails when the icon link is outside the head", () => {
    const moved = page(MAIN).replace(ICON_LINKS, "").replace("<main>", `${ICON_LINKS}<main>`);
    const problems = verifyOutput(site({ main: moved }), sampleExpected);
    expect(problems).toContain("index.html: no icon link to /icon.svg in the head");
  });
});
