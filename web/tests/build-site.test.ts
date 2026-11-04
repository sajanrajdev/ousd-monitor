import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRelease, buildSite, Refused } from "@/scripts/build-site.mjs";
import { at, copySample, editJson, plantFile, releaseGrade, tempDir } from "./dataset-helpers";

const LINE = "Independent. Not affiliated with Open Standard or Bridge.";
const VERSION = "20261104T060000Z";
const quiet = () => {};

function realPage(body: string) {
  return `<!doctype html><html data-dataset-kind="real" data-dataset-version="${VERSION}"><head><title>Open USD Monitor</title></head><body>
    <header><p>${LINE}</p></header>${body}
    <footer><p>${LINE}</p><p>Not financial advice.</p></footer></body></html>`;
}

function goodRealBuild(_webRoot: string, target: string) {
  plantFile(target, "index.html", realPage("<main>Fine</main>"));
  plantFile(target, "methodology/index.html", realPage("<main>Fine</main>"));
}

function badRealBuild(_webRoot: string, target: string) {
  goodRealBuild(_webRoot, target);
  plantFile(target, "index.html", realPage("<main>Held at Coinbase</main>"));
}

// A release root that already has a last good version, to see whether it moves.
function releaseRootWithLastGood(): string {
  const root = tempDir();
  mkdirSync(join(root, "previous"));
  writeFileSync(join(root, "previous", "marker"), "last good");
  symlinkSync("previous", join(root, "latest"));
  return root;
}

const webRoot = process.cwd();

function asEnv(values: Record<string, string | undefined>) {
  return values as NodeJS.ProcessEnv;
}

function releaseOptions(dataset: string, releaseRoot: string, env = {}) {
  return {
    location: at(dataset),
    webRoot,
    releaseRoot,
    env: asEnv(env),
    log: quiet,
    build: goodRealBuild,
  };
}

describe("make web-release", () => {
  it("builds a release-grade dataset, and points latest at it", () => {
    const root = releaseRootWithLastGood();
    buildRelease({ ...releaseOptions(releaseGrade(), root), now: () => 42 });
    expect(readlinkSync(join(root, "latest"))).toBe(`${VERSION}-42`);
    expect(existsSync(join(root, "latest", "index.html"))).toBe(true);
    expect(existsSync(join(root, "previous"))).toBe(false);
  });

  it.each([
    ["a sample", () => copySample("complete"), /sample data, never a release/],
    ["a partial sample", () => copySample("partial"), /sample data, never a release/],
  ])("refuses %s, and latest doesn't move", (_name, make, message) => {
    const root = releaseRootWithLastGood();
    expect(() => buildRelease(releaseOptions(make(), root))).toThrow(message);
    expect(readlinkSync(join(root, "latest"))).toBe("previous");
  });

  it("refuses a preview, naming why", () => {
    const root = releaseRootWithLastGood();
    const dir = releaseGrade();
    editJson(dir, "reconciliation.json", (payload) => {
      payload.data = payload.data.filter((row: { subject: string }) => row.subject !== "solana");
    });
    expect(() => buildRelease(releaseOptions(dir, root))).toThrow(
      /isn't release grade[\s\S]*solana needs one passed chain row/,
    );
    expect(readlinkSync(join(root, "latest"))).toBe("previous");
  });

  it("a mismatched dataset fails, and latest doesn't move", () => {
    const root = releaseRootWithLastGood();
    const dir = releaseGrade();
    editJson(dir, "manifest.json", (manifest) => {
      manifest.files["journey.csv"].rows += 1;
    });
    expect(() => buildRelease(releaseOptions(dir, root))).toThrow(/journey\.csv: rows/);
    expect(readlinkSync(join(root, "latest"))).toBe("previous");
    expect(readFileSync(join(root, "latest", "marker"), "utf8")).toBe("last good");
  });

  it("a failing verify-output leaves latest unchanged, and no leftovers", () => {
    const root = releaseRootWithLastGood();
    const options = { ...releaseOptions(releaseGrade(), root), build: badRealBuild };
    expect(() => buildRelease(options)).toThrow(/failed verification[\s\S]*names "Coinbase"/);
    expect(readlinkSync(join(root, "latest"))).toBe("previous");
    expect(readFileSync(join(root, "latest", "marker"), "utf8")).toBe("last good");
    expect(readdirSync(root).sort()).toEqual(["latest", "previous"]);
  });

  it("a failing build leaves latest unchanged", () => {
    const root = releaseRootWithLastGood();
    const options = {
      ...releaseOptions(releaseGrade(), root),
      build: () => {
        throw new Refused("next build failed.");
      },
    };
    expect(() => buildRelease(options)).toThrow("next build failed.");
    expect(readlinkSync(join(root, "latest"))).toBe("previous");
    expect(readdirSync(root).sort()).toEqual(["latest", "previous"]);
  });

  it("a dataset swapped for a sample during the build can't ship", () => {
    const root = releaseRootWithLastGood();
    const dir = releaseGrade();
    const swappedBuild = (webRootArg: string, target: string) => {
      // What Next would see: the pointer moved after the gate, so the pages say sample.
      editJson(dir, "manifest.json", (manifest) => {
        manifest.git_commit = "0".repeat(40);
        manifest.dataset_version = "20261105T060000Z";
      });
      goodRealBuild(webRootArg, target);
      for (const page of ["index.html", "methodology/index.html"]) {
        const path = join(target, page);
        const html = readFileSync(path, "utf8")
          .replace('data-dataset-kind="real"', 'data-dataset-kind="sample"')
          .replace(VERSION, "20261105T060000Z");
        writeFileSync(path, html);
      }
    };
    expect(() => buildRelease({ ...releaseOptions(dir, root), build: swappedBuild })).toThrow(
      /failed verification[\s\S]*page root says sample, dataset is real/,
    );
    expect(readlinkSync(join(root, "latest"))).toBe("previous");
    expect(readdirSync(root).sort()).toEqual(["latest", "previous"]);
  });

  it("a first release has no latest to replace", () => {
    const root = tempDir();
    buildRelease({ ...releaseOptions(releaseGrade(), root), now: () => 1 });
    expect(readlinkSync(join(root, "latest"))).toBe(`${VERSION}-1`);
  });

  describe("warnings", () => {
    const warned = () => {
      const dir = releaseGrade();
      editJson(dir, "manifest.json", (manifest) => {
        manifest.warnings = [
          { chain: "base", metric: "total_supply", day: "2026-11-02", previous: "1", current: "2" },
        ];
      });
      return dir;
    };

    it("refuses without the matching OUSD_ACK_WARNINGS, and prints each one", () => {
      const root = releaseRootWithLastGood();
      const lines: string[] = [];
      const options = {
        ...releaseOptions(warned(), root),
        log: (line: string) => lines.push(line),
      };
      expect(() => buildRelease(options)).toThrow(/OUSD_ACK_WARNINGS/);
      expect(lines.join()).toContain("base total_supply on 2026-11-02");
      expect(readlinkSync(join(root, "latest"))).toBe("previous");

      const wrong = { ...options, env: asEnv({ OUSD_ACK_WARNINGS: "another-version" }) };
      expect(() => buildRelease(wrong)).toThrow(/OUSD_ACK_WARNINGS/);
    });

    it("builds with it", () => {
      const root = releaseRootWithLastGood();
      const options = releaseOptions(warned(), root, { OUSD_ACK_WARNINGS: VERSION });
      buildRelease({ ...options, now: () => 7 });
      expect(readlinkSync(join(root, "latest"))).toBe(`${VERSION}-7`);
    });

    it("a dataset without warnings needs nothing", () => {
      const root = releaseRootWithLastGood();
      buildRelease({ ...releaseOptions(releaseGrade(), root), now: () => 9 });
      expect(readlinkSync(join(root, "latest"))).toBe(`${VERSION}-9`);
    });

    it("a normal build only logs them", () => {
      const lines: string[] = [];
      const dir = copySample("complete");
      editJson(dir, "manifest.json", (manifest) => {
        manifest.warnings = [
          { chain: "base", metric: "total_supply", day: "2026-11-02", previous: "1", current: "2" },
        ];
      });
      expect(() =>
        buildSite({
          name: "warned",
          location: at(dir),
          webRoot,
          log: (line: string) => lines.push(line),
          build: () => {
            throw new Refused("stopped after the log");
          },
        }),
      ).toThrow(/stopped after the log/);
      expect(lines.join()).toContain("base total_supply on 2026-11-02");
    });
  });
});

describe("a real command line", () => {
  const SCRIPT = [
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "scripts/build-site.mjs",
  ];

  // Without the test runner's NODE_ENV, which Next rejects.
  function withDataset(dataset: string) {
    return asEnv({
      ...process.env,
      NODE_ENV: undefined,
      OUSD_DATASET_DIR: dataset,
      NEXT_TELEMETRY_DISABLED: "1",
    });
  }

  function run(args: string[], dataset: string) {
    return spawnSync(process.execPath, [...SCRIPT, ...args], {
      cwd: webRoot,
      env: withDataset(dataset),
      encoding: "utf8",
    });
  }

  it("a dataset failing schema validation exits non-zero, naming the file and field", () => {
    const dir = copySample("complete");
    editJson(dir, "summary.json", (payload) => {
      payload.verdict.state = "thriving";
    });
    const result = run(["test-bad"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Dataset refused: summary.json");
    expect(result.stderr).toContain("/verdict/state");
    expect(result.stderr).not.toContain(dir);
  });

  it("--release refuses the sample, with no off switch", () => {
    const result = run(["--release"], "fixtures/dataset/complete");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refused: this is sample data, never a release.");
  });

  it("--release refuses a sample copied outside web/ with FIXTURE removed", () => {
    const dir = releaseGrade();
    editJson(dir, "manifest.json", (manifest) => {
      manifest.git_commit = "0".repeat(40);
    });
    const result = run(["--release"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refused: this is sample data");
  });

  it("next build itself fails on a bad dataset, as the page loads it too", () => {
    const dir = copySample("partial");
    editJson(dir, "journey.json", (payload) => {
      const row = payload.data[0];
      row.free_floating = String(BigInt(row.free_floating) + 1n);
    });
    const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
      cwd: webRoot,
      env: withDataset(dir),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("parts don't add up to total_supply");
  }, 180_000);
});
