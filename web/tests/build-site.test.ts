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
import { expectedFromDataset } from "@/scripts/verify-output.mjs";
import { at, copySample, editJson, plantFile, releaseGrade, tempDir } from "./dataset-helpers";
import {
  plantedFlight,
  plantedFooter,
  plantedRealMain,
  plantedReconciliationMain,
  PLANTED_HEADER,
  plantedBack,
} from "./planted-first-screen";

const VERSION = "20261104T060000Z";
const quiet = () => {};

const STALE_TRUST =
  "Last reconciled 4 Nov 2026, 05:30 UTC. Nothing newer has reached this page, so it may be out of date.";

const STALE_RUN =
  "Last run 4 Nov 2026, 05:30 UTC: every check passed. Nothing newer has reached this page, so it may be out of date.";

// What a build of the release-grade copy writes, long past its 36 hours, so it didn't pass: real
// data that's only old, so the footer says so with its clock, never "Reconciled", and nothing sits
// at the top.
function realPage(body: string) {
  return `<!doctype html><html data-dataset-kind="real" data-dataset-version="${VERSION}" data-freshness="stale"><head><title>Open USD Monitor</title></head><body>
    ${PLANTED_HEADER}${plantedFlight([])}${body}
    ${plantedFooter(false, { fresh: null, stale: STALE_TRUST, short: "Last reconciled 4 Nov" })}</body></html>`;
}

const realMain = () => plantedRealMain(expectedFromDataset(at(releaseGrade())), STALE_TRUST);

function goodRealBuild(_webRoot: string, target: string) {
  plantFile(target, "index.html", realPage(realMain()));
  plantFile(target, "methodology/index.html", plantedBack(realPage("<main>Fine</main>")));
  plantFile(target, "reconciliation/index.html", realPage(plantedReconciliationMain(STALE_RUN)));
}

function badRealBuild(_webRoot: string, target: string) {
  goodRealBuild(_webRoot, target);
  plantFile(target, "index.html", realPage(`${realMain()}<p>Held at Coinbase</p>`));
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

    describe("OUSD_ACK_WARNING_KEYS", () => {
      const KEYS = "ethereum:circulating_supply, base:total_supply";

      it("builds when every warning's chain and metric is listed, and logs the keys", () => {
        const root = releaseRootWithLastGood();
        const lines: string[] = [];
        const options = {
          ...releaseOptions(warned(), root, { OUSD_ACK_WARNING_KEYS: KEYS }),
          log: (line: string) => lines.push(line),
        };
        buildRelease({ ...options, now: () => 11 });
        expect(readlinkSync(join(root, "latest"))).toBe(`${VERSION}-11`);
        const log = lines.join("\n");
        expect(log).toContain("base total_supply on 2026-11-02");
        expect(log).toContain(
          "Acknowledged warning keys: ethereum:circulating_supply, base:total_supply.",
        );
      });

      it("refuses a warning whose key isn't listed, naming it", () => {
        const root = releaseRootWithLastGood();
        const options = releaseOptions(warned(), root, {
          OUSD_ACK_WARNING_KEYS: "ethereum:circulating_supply,base:circulating_supply",
        });
        expect(() => buildRelease(options)).toThrow(/aren't acknowledged: base:total_supply/);
        expect(readlinkSync(join(root, "latest"))).toBe("previous");
      });

      it("refuses when only some of the warnings are listed", () => {
        const dir = warned();
        editJson(dir, "manifest.json", (manifest) => {
          manifest.warnings.push({
            chain: "solana",
            metric: "total_supply",
            day: "2026-11-02",
            previous: "1",
            current: "2",
          });
        });
        const root = releaseRootWithLastGood();
        const options = releaseOptions(dir, root, { OUSD_ACK_WARNING_KEYS: KEYS });
        expect(() => buildRelease(options)).toThrow(/aren't acknowledged: solana:total_supply\./);
        expect(readlinkSync(join(root, "latest"))).toBe("previous");
      });

      it("a dataset without warnings needs no keys, and still logs any set", () => {
        const root = releaseRootWithLastGood();
        const lines: string[] = [];
        buildRelease({
          ...releaseOptions(releaseGrade(), root, { OUSD_ACK_WARNING_KEYS: KEYS }),
          log: (line: string) => lines.push(line),
          now: () => 12,
        });
        expect(readlinkSync(join(root, "latest"))).toBe(`${VERSION}-12`);
        expect(lines.join("\n")).toContain("Acknowledged warning keys:");
      });

      it("refuses a malformed entry, even with no warnings", () => {
        const root = releaseRootWithLastGood();
        for (const bad of ["ethereum", "ethereum:circulating_supply:x", "Ethereum:supply", "*:*"]) {
          const options = releaseOptions(releaseGrade(), root, { OUSD_ACK_WARNING_KEYS: bad });
          expect(() => buildRelease(options)).toThrow(/aren't chain:metric/);
        }
        expect(readlinkSync(join(root, "latest"))).toBe("previous");
      });

      it("an empty value acknowledges nothing", () => {
        const root = releaseRootWithLastGood();
        const options = releaseOptions(warned(), root, { OUSD_ACK_WARNING_KEYS: " , " });
        expect(() => buildRelease(options)).toThrow(/aren't acknowledged/);
      });

      it("a malformed entry refuses even with the matching OUSD_ACK_WARNINGS", () => {
        const root = releaseRootWithLastGood();
        const options = releaseOptions(warned(), root, {
          OUSD_ACK_WARNING_KEYS: "ethereum",
          OUSD_ACK_WARNINGS: VERSION,
        });
        expect(() => buildRelease(options)).toThrow(/aren't chain:metric/);
      });

      it("the per-version OUSD_ACK_WARNINGS still works alongside it", () => {
        const root = releaseRootWithLastGood();
        const options = releaseOptions(warned(), root, {
          OUSD_ACK_WARNING_KEYS: "ethereum:circulating_supply",
          OUSD_ACK_WARNINGS: VERSION,
        });
        buildRelease({ ...options, now: () => 13 });
        expect(readlinkSync(join(root, "latest"))).toBe(`${VERSION}-13`);
      });
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

describe("make web-release on KPI rows", () => {
  it.each([
    ["missing", (kpis: { chain: string }[]) => kpis.filter((row) => row.chain !== "solana")],
    ["duplicated", (kpis: { chain: string }[]) => [...kpis, kpis[0]]],
  ])("a %s row is refused, and latest doesn't move", (_name, change) => {
    const root = releaseRootWithLastGood();
    const dir = releaseGrade();
    editJson(dir, "summary.json", (payload) => {
      payload.kpis = change(payload.kpis);
    });
    expect(() => buildRelease(releaseOptions(dir, root))).toThrow(/summary\.json: \/kpis/);
    expect(readlinkSync(join(root, "latest"))).toBe("previous");
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

  it("an empty OUSD_DATASET_DIR is refused, not read as unset", () => {
    const result = run(["test-empty"], "");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Dataset refused: OUSD_DATASET_DIR");
    expect(existsSync(join(webRoot, ".build", "test-empty"))).toBe(false);
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
