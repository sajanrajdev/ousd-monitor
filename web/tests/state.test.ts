import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatasetError, loadDataset, loadDatasetFiles } from "@/lib/dataset/load";
import { deriveState, freshnessClock, isFreshAt, releaseProblems } from "@/lib/dataset/state";
import {
  asVersion2,
  at,
  copySample,
  editJson,
  markStale,
  readJson,
  releaseGrade,
  tempDir,
  type Json,
} from "./dataset-helpers";

const GENERATED = Date.parse("2026-11-04T06:00:00Z");
// Fresh for every time in the sample: a few hours after it was generated.
const SOON = Date.parse("2026-11-04T08:00:00Z");
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function stateOf(dir: string, now = SOON) {
  return loadDataset(at(dir), { now }).state;
}

function edited(file: string, change: (payload: Json) => void, dir = releaseGrade()): string {
  editJson(dir, file, change);
  return dir;
}

describe("dataset states", () => {
  it("sample: a FIXTURE file beside the manifest", () => {
    const dir = copySample("complete");
    editJson(dir, "manifest.json", (manifest) => {
      manifest.git_commit = "abc1234".padEnd(40, "0");
    });
    expect(stateOf(dir).kind).toBe("sample");
  });

  describe("under web/, with every other sample mark taken off", () => {
    function underWeb() {
      mkdirSync(".build", { recursive: true });
      const dir = mkdtempSync(join(process.cwd(), ".build", "state-test-"));
      cpSync(releaseGrade(), dir, { recursive: true });
      return dir;
    }

    it("sample: a path under web/", () => {
      const dir = underWeb();
      try {
        expect(stateOf(dir).kind).toBe("sample");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("sample: a pointer outside web/ that resolves under it", () => {
      const dir = underWeb();
      const pointer = join(tempDir(), "latest");
      symlinkSync(dir, pointer);
      try {
        expect(stateOf(pointer).kind).toBe("sample");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("sample: copied outside web/ with FIXTURE removed, still sample through git_commit", () => {
    const dir = releaseGrade();
    editJson(dir, "manifest.json", (manifest) => {
      manifest.git_commit = "0".repeat(40);
    });
    const state = stateOf(dir);
    expect(state.kind).toBe("sample");
    expect(state.frameWord).toBe("Sample");
    expect(state.banner?.headline).toBe("Sample data. Nothing here is real.");
  });

  it("sample outranks preview, and shows its chain and check counts", () => {
    const state = stateOf(copySample("partial"));
    expect(state.kind).toBe("sample");
    expect(state.banner?.headline).toBe("Sample data. Nothing here is real.");
    expect(state.banner?.details).toEqual(["2 of 4 chains, 2 checks not passed."]);
    expect(state.trustLine.fresh).toBe("Not reconciled");
  });

  it("says when the sample is only a fallback", () => {
    const dataset = loadDataset({ dir: "fixtures/dataset/complete", origin: "sample-fallback" });
    expect(dataset.state.banner?.details).toContain(
      "No published dataset was found, so this build shows the sample.",
    );
  });

  it("preview: `preview` true", () => {
    const dir = copySample("partial");
    edited(
      "manifest.json",
      (manifest) => {
        manifest.git_commit = "abc1234".padEnd(40, "0");
      },
      dir,
    );
    rmSync(join(dir, "FIXTURE"));
    const state = stateOf(dir);
    expect(state.kind).toBe("preview");
    expect(state.frameWord).toBe("Preview");
    expect(state.banner?.headline).toBe("Local preview. Not the published site.");
    expect(state.banner?.details).toEqual(["2 of 4 chains, 2 checks not passed."]);
    expect(state.trustLine.fresh).toBe("Not reconciled");
    expect(state.trustLine.stale).toBe("Not reconciled");
  });

  it("preview: clean counts and missing evidence say so", () => {
    const dir = edited("reconciliation.json", (payload) => {
      payload.data = [];
    });
    const state = stateOf(dir);
    expect(state.kind).toBe("preview");
    expect(state.banner?.details).toEqual(["Reconciliation evidence is missing."]);
  });

  it("preview: clean counts and clean evidence don't claim evidence is missing", () => {
    const dir = edited("manifest.json", (manifest) => {
      manifest.definitions.placed_days = 30;
    });
    expect(stateOf(dir).banner?.details).toEqual(["It doesn't meet the rules for a release."]);
  });

  it.each([
    ["stale.json beside it", () => markStale(releaseGrade())],
    [
      "a version 2 manifest marked stale",
      () => edited("manifest.json", (manifest) => asVersion2(manifest, "a check failed")),
    ],
  ])("real, %s: same data, and the strip changes", (_name, make) => {
    const state = stateOf(make());
    expect(state.kind).toBe("real");
    expect(state.banner).toBeNull();
    expect(state.freshness).toBe("stale");
    expect(state.asOfLine.fresh).toBeNull();
    expect(state.asOfLine.stale).toBe(
      "A newer run did not pass its checks. Data from 4 Nov 2026, 06:00 UTC.",
    );
    expect(state.trustLine.fresh).toBeNull();
    expect(state.trustLine.stale).toContain("Last reconciled 4 Nov 2026, 05:30 UTC.");
    expect(state.trustLine.stale).toContain("A newer run did not pass its checks.");
  });

  it("real, older than the limit at build", () => {
    const state = stateOf(releaseGrade(), GENERATED + 40 * HOUR);
    expect(state.kind).toBe("real");
    expect(state.freshness).toBe("stale");
    expect(state.asOfLine.stale).toBe(
      "Data from 4 Nov 2026, 06:00 UTC. Nothing newer has reached this page, so it may be out of date.",
    );
    expect(state.trustLine.fresh).toBeNull();
  });

  it("real, fresh", () => {
    const state = stateOf(releaseGrade());
    expect(state.kind).toBe("real");
    expect(state.frameWord).toBeNull();
    expect(state.banner).toBeNull();
    expect(state.freshness).toBe("fresh");
    expect(state.releaseProblems).toEqual([]);
    expect(state.trustLine.fresh).toBe(
      "Supply reconciled on all 4 chains as of 4 Nov 2026, 05:30 UTC",
    );
    expect(state.asOfLine.fresh).toBe("Data as of 2 Nov 2026 to 3 Nov 2026 UTC.");
  });

  it("a stale note still appears on a sample, and the strip stays not reconciled", () => {
    const state = stateOf(copySample("complete"), GENERATED + 40 * HOUR);
    expect(state.freshness).toBe("stale");
    expect(state.asOfLine.stale).toContain("Nothing newer has reached this page");
    expect(state.trustLine.stale).toBe("Not reconciled");
  });
});

describe("release grade, rejected by the schema when `preview` is false, so a load failure", () => {
  const fails = (dir: string, field: string) => {
    expect(() => loadDataset(at(dir))).toThrow(DatasetError);
    expect(() => loadDataset(at(dir))).toThrow(field);
  };

  it("three chains with complete true", () => {
    const dir = edited("manifest.json", (manifest) => {
      manifest.coverage.chains_included = ["tempo", "ethereum", "base"];
    });
    fails(dir, "/coverage/chains_included");
  });

  it("a check absent", () => {
    const dir = edited("manifest.json", (manifest) => {
      manifest.checks.pop();
    });
    fails(dir, "/checks");
  });

  it("a check skipped", () => {
    const dir = edited("manifest.json", (manifest) => {
      manifest.checks[2].status = "skipped";
    });
    fails(dir, "/checks/2/status");
  });

  // The plan expected the schema to accept this. Its checks are positional, each with a const name.
  it("a check duplicated", () => {
    const dir = edited("manifest.json", (manifest) => {
      manifest.checks[1] = { ...manifest.checks[0] };
    });
    fails(dir, "/checks/1/name");
  });
});

describe("release grade, accepted by the schema, so preview and a refusal naming why", () => {
  const cases: [string, string, (payload: Json) => void, string][] = [
    [
      "a tree with uncommitted changes",
      "manifest.json",
      (manifest) => {
        manifest.provenance.tree_state = "dirty";
      },
      "it was published from a tree with uncommitted changes",
    ],
    [
      "an empty reconciliation.json",
      "reconciliation.json",
      (payload) => {
        payload.data = [];
        payload.latest_run = null;
      },
      "latest_run isn't a full run that passed",
    ],
    [
      "a missing Solana row",
      "reconciliation.json",
      (payload) => {
        payload.data = payload.data.filter((row: Json) => row.subject !== "solana");
      },
      "solana needs one passed chain row, and has 0",
    ],
    [
      "a missing Bridge row",
      "reconciliation.json",
      (payload) => {
        payload.data = payload.data.filter((row: Json) => row.kind !== "bridge");
      },
      "Bridge needs one passed row, and has 0",
    ],
    [
      "a chain row from another run",
      "reconciliation.json",
      (payload) => {
        payload.data.find((row: Json) => row.subject === "base").run_id = "another-run";
      },
      "base's chain row is from another run",
    ],
    [
      "a Bridge row not in_latest_run",
      "reconciliation.json",
      (payload) => {
        payload.data.find((row: Json) => row.kind === "bridge").in_latest_run = false;
      },
      "Bridge's row isn't in the latest run",
    ],
    [
      "latest_run partial",
      "reconciliation.json",
      (payload) => {
        payload.latest_run.scope = "partial";
      },
      "latest_run isn't a full run that passed",
    ],
    [
      "rows missing for one chain in journey",
      "journey.json",
      (payload) => {
        payload.data = payload.data.filter((row: Json) => row.chain !== "tempo");
      },
      "tempo has no journey rows",
    ],
    [
      "verdict.scope short of four",
      "summary.json",
      (payload) => {
        payload.verdict.scope = ["tempo", "ethereum", "base"];
      },
      "verdict.scope doesn't cover solana",
    ],
    [
      "changed definitions",
      "manifest.json",
      (manifest) => {
        manifest.definitions.large_transfer_base_units = "1";
      },
      "manifest.definitions differ from the documented defaults",
    ],
    [
      "a velocity formula changed",
      "manifest.json",
      (manifest) => {
        manifest.definitions.velocity.velocity_bps.denominator = "total_supply";
      },
      "manifest.definitions differ from the documented defaults",
    ],
    [
      "manifest.reconciliation not passing",
      "manifest.json",
      (manifest) => {
        manifest.reconciliation.status = "fail";
      },
      "manifest.reconciliation isn't a full run that passed",
    ],
  ];

  it.each(cases)("%s", (_name, file, change, reason) => {
    const state = stateOf(edited(file, change));
    expect(state.kind).toBe("preview");
    expect(state.frameWord).toBe("Preview");
    expect(state.releaseProblems).toContain(reason);
  });
});

// The schema stops these in a real load. The state step still checks, in case a schema loosens.
describe("the tree a dataset was published from", () => {
  it.each(["clean", "unknown"])(
    "a %s tree can be real, as an image has no tree to read",
    (tree) => {
      const dir = edited("manifest.json", (manifest) => {
        manifest.provenance.tree_state = tree;
      });
      expect(stateOf(dir).kind).toBe("real");
    },
  );

  it("a version 2 manifest recorded no tree, and can still be real", () => {
    const dir = edited("manifest.json", (manifest) => asVersion2(manifest));
    expect(stateOf(dir).kind).toBe("real");
  });

  it("a dirty tree still builds as a local preview", () => {
    const dir = edited("manifest.json", (manifest) => {
      manifest.provenance.tree_state = "dirty";
    });
    const state = stateOf(dir);
    expect(state.kind).toBe("preview");
    expect(state.banner?.headline).toBe("Local preview. Not the published site.");
  });
});

describe("release grade, on files already in memory", () => {
  const files = () => loadDatasetFiles(at(releaseGrade())).files;

  it("names a duplicated check, and the one it pushed out", () => {
    const loaded = files();
    loaded.manifest.checks[1] = { ...loaded.manifest.checks[0] };
    const problems = releaseProblems(loaded);
    expect(problems).toContain("check chain_supply appears 2 times");
    expect(problems).toContain("check cross_chain_supply appears 0 times");
  });

  it("names a skipped check, and the wrong count", () => {
    const loaded = files();
    loaded.manifest.checks[2].status = "skipped";
    loaded.manifest.checks.pop();
    const problems = releaseProblems(loaded);
    expect(problems).toContain("check sampled_balances is skipped");
    expect(problems).toContain("there aren't exactly 7 checks");
  });

  it("names two different runs", () => {
    const loaded = files();
    loaded.manifest.reconciliation!.run_id = "another-run";
    expect(releaseProblems(loaded)).toContain(
      "manifest.reconciliation and latest_run are different runs",
    );
  });
});

describe("KPI rows, on files already in memory", () => {
  const files = () => loadDatasetFiles(at(releaseGrade())).files;

  it("names a missing row", () => {
    const loaded = files();
    loaded.summary.kpis = loaded.summary.kpis.filter((row) => row.chain !== "solana");
    expect(releaseProblems(loaded)).toContain("solana needs one KPI row, and has 0");
  });

  it("names a duplicated row", () => {
    const loaded = files();
    loaded.summary.kpis.push(loaded.summary.kpis[0]);
    expect(releaseProblems(loaded)).toContain("tempo needs one KPI row, and has 2");
  });
});

describe("a time in the future", () => {
  const FAR = "2099-01-01T00:00:00Z";
  const cases: [string, (manifest: Json, time: string) => void][] = [
    ["reconciliation.finished_at", (data, time) => (data.reconciliation.finished_at = time)],
    ["a chain's last_transfer_at", (data, time) => (data.coverage.last_transfer_at.base = time)],
  ];

  it.each(cases)("%s reads stale, and never as reconciled", (_name, place) => {
    const dir = edited("manifest.json", (data) => place(data, FAR));
    const state = stateOf(dir, GENERATED + HOUR);
    expect(state.freshness).toBe("stale");
    expect(state.kind).toBe("preview");
    expect(state.trustLine.fresh).toBe("Not reconciled");
    expect(state.releaseProblems.join()).toContain("later than generated_at");
  });

  it.each(cases)("%s reads stale on the reader's clock too", (_name, place) => {
    const data = readJson(releaseGrade(), "manifest.json");
    place(data, FAR);
    expect(isFreshAt(freshnessClock(data), GENERATED + HOUR)).toBe(false);
  });

  it.each(cases)("%s a little ahead is clock skew, and stays fresh", (_name, place) => {
    const dir = edited("manifest.json", (data) => place(data, "2026-11-04T06:04:00Z"));
    const state = stateOf(dir, GENERATED);
    expect(state.freshness).toBe("fresh");
    expect(state.kind).toBe("real");
  });

  it.each(cases)("%s past the skew is stale", (_name, place) => {
    const dir = edited("manifest.json", (data) => place(data, "2026-11-04T06:06:00Z"));
    const state = stateOf(dir, GENERATED);
    expect(state.freshness).toBe("stale");
    expect(state.kind).toBe("preview");
  });
});

describe("the as-of line", () => {
  it("is never blank on a fresh dataset with no as-of days", () => {
    const { files, placement } = loadDatasetFiles(at(releaseGrade()));
    files.summary.verdict.as_of = {};
    const state = deriveState(files, placement, SOON);
    expect(state.freshness).toBe("fresh");
    expect(state.asOfLine.fresh).toBe("Not enough data yet");
  });
});

describe("freshness, with a fake clock", () => {
  const manifest = () => readJson(releaseGrade(), "manifest.json");

  function withOneTimeOld(place: (manifest: Json, time: string) => void) {
    const data = manifest();
    const now = Date.parse("2026-11-04T06:00:00Z");
    return (age: number) => {
      place(data, new Date(now - age).toISOString().replace(".000Z", "Z"));
      return isFreshAt(freshnessClock(data), now);
    };
  }

  const places: [string, (manifest: Json, time: string) => void][] = [
    ["generated_at", (data, time) => (data.generated_at = time)],
    ["reconciliation.finished_at", (data, time) => (data.reconciliation.finished_at = time)],
    ["a chain's last_transfer_at", (data, time) => (data.coverage.last_transfer_at.base = time)],
  ];

  it.each(places)("%s: 35h59m is fresh and 36h01m is stale", (_name, place) => {
    const freshAtAge = withOneTimeOld(place);
    expect(freshAtAge(35 * HOUR + 59 * MINUTE)).toBe(true);
    expect(freshAtAge(36 * HOUR + MINUTE)).toBe(false);
  });

  it("a recent generated_at with a 40-hour-old reconciliation is stale", () => {
    const dir = edited("manifest.json", (data) => {
      data.reconciliation.finished_at = "2026-11-02T14:00:00Z";
    });
    expect(stateOf(dir, GENERATED).freshness).toBe("stale");
  });

  it("stale.json is stale whatever the clock says", () => {
    expect(stateOf(markStale(releaseGrade()), GENERATED).freshness).toBe("stale");
  });

  it("a future generated_at is stale", () => {
    const clock = freshnessClock(manifest());
    expect(isFreshAt(clock, GENERATED - MINUTE)).toBe(false);
    expect(isFreshAt(clock, GENERATED)).toBe(true);
  });

  it("a dataset with no reconciliation can't be fresh", () => {
    const data = manifest();
    data.reconciliation = null;
    expect(isFreshAt(freshnessClock(data), GENERATED)).toBe(false);
  });
});
