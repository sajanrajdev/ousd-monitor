// @vitest-environment node
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { satisfies } from "../scripts/node-range.mjs";

const RANGE = "^22.12 || ^24";
const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));

describe("satisfies", () => {
  it.each(["v22.12.0", "v22.23.4", "v24.0.0", "v24.10.0"])("accepts %s", (version) => {
    expect(satisfies(version, RANGE)).toBe(true);
  });

  it.each(["v20.19.0", "v22.11.9", "v23.0.0", "v26.0.0"])("refuses %s", (version) => {
    expect(satisfies(version, RANGE)).toBe(false);
  });

  it("throws on a range it can't read", () => {
    expect(() => satisfies("v24.0.0", ">=24")).toThrow(">=24");
  });
});

describe("check-node", () => {
  const made: string[] = [];

  function siteWithRange(range: string) {
    const dir = mkdtempSync(join(tmpdir(), "check-node-"));
    made.push(dir);
    cpSync(SCRIPTS, join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: range } }));
    return dir;
  }

  function run(script: string) {
    return spawnSync(process.execPath, [script], { encoding: "utf8" });
  }

  afterEach(() => {
    made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it("passes on the running Node with the real range", () => {
    expect(run(join(SCRIPTS, "check-node.mjs")).status).toBe(0);
  });

  it("fails out of range and says what to install", () => {
    const result = run(join(siteWithRange("^1"), "scripts", "check-node.mjs"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Install Node ^1.");
  });

  it("still checks when reached through a symlink", () => {
    const link = join(mkdtempSync(join(tmpdir(), "check-node-link-")), "site");
    made.push(join(link, ".."));
    symlinkSync(siteWithRange("^1"), link);

    expect(run(join(link, "scripts", "check-node.mjs")).status).toBe(1);
  });

  it("fails on a range it can't read", () => {
    expect(run(join(siteWithRange(">=1"), "scripts", "check-node.mjs")).status).not.toBe(0);
  });
});
