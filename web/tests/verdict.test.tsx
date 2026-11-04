import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerdictBlock } from "@/components/verdict-block";
import { loadDataset, type Dataset } from "@/lib/dataset/load";
import { VERDICT_SENTENCES, verdictSentence, verdictTextVisible } from "@/lib/verdict";
import { at, copySample, editJson, releaseGrade } from "./dataset-helpers";

const SOON = Date.parse("2026-11-04T08:00:00Z");

function sample(name: "complete" | "partial" = "complete"): Dataset {
  return loadDataset(at(copySample(name)), { now: SOON });
}

function real(change?: Parameters<typeof editJson>[2]): Dataset {
  const dir = releaseGrade();
  if (change) editJson(dir, "summary.json", change);
  return loadDataset(at(dir), { now: SOON });
}

function preview(): Dataset {
  const dir = copySample("partial");
  rmSync(join(dir, "FIXTURE"));
  editJson(dir, "manifest.json", (manifest) => {
    manifest.git_commit = "abc1234";
  });
  editJson(dir, "summary.json", (summary) => {
    summary.verdict.text = `Local preview, not a finding. ${summary.verdict.text}`;
  });
  return loadDataset(at(dir), { now: SOON });
}

function renderBlock(dataset: Dataset, change: (verdict: Dataset["summary"]["verdict"]) => void) {
  const verdict = structuredClone(dataset.summary.verdict);
  change(verdict);
  return render(
    <VerdictBlock verdict={verdict} kpis={dataset.summary.kpis} state={dataset.state} />,
  );
}

describe("the headline's text rule", () => {
  // A copy on purpose, so a change to VERDICT_SENTENCES has to edit this test too.
  const TODAY = {
    mostly_placed: "At least half of Open USD (OUSD) supply is sitting still.",
    moving:
      "Under half of Open USD (OUSD) supply is sitting still, and everyday transfers are at least 5% of supply a week.",
    mixed:
      "Neither mostly placed nor clearly moving: the data doesn't support a clear statement on Open USD (OUSD) yet.",
    no_clear_statement: "The data doesn't support a clear statement on Open USD (OUSD) yet.",
  };

  it("the four sentences are today's, unchanged", () => {
    expect(VERDICT_SENTENCES).toEqual(TODAY);
  });

  it("the headline is the generated sentence, at the headline's size, and in view", () => {
    const { container } = renderBlock(real(), () => {});
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe(TODAY.mostly_placed);
    expect(heading.closest("details")).toBeNull();
    expect(heading.hasAttribute("style")).toBe(false);
    expect(
      container.querySelector(".status-chip[data-kind='opinion']")!.closest("details"),
    ).toBeNull();
    expect(readFileSync("app/globals.css", "utf8")).toMatch(
      /\.verdict-block__head h1 \{[^}]*font-size: var\(--text-headline\)/,
    );
  });

  it("verdict.text moves only on real data across all four chains", () => {
    expect(verdictTextVisible(real().summary.verdict, { kind: "real" })).toBe(false);
    for (const kind of ["sample", "preview"] as const) {
      expect(verdictTextVisible(sample().summary.verdict, { kind })).toBe(true);
    }
    expect(verdictTextVisible(sample("partial").summary.verdict, { kind: "real" })).toBe(true);
    expect(verdictTextVisible({ scope: [] }, { kind: "real" })).toBe(true);
    expect(verdictTextVisible({ scope: ["tempo", "ethereum", "base"] }, { kind: "real" })).toBe(
      true,
    );
  });

  it.each(["complete", "partial"] as const)("%s sample: verdict.text is on screen", (name) => {
    const dataset = sample(name);
    const { container } = renderBlock(dataset, () => {});
    const text = container.querySelector("[data-verdict-text]")!;
    expect(text.closest("details")).toBeNull();
    expect(text.textContent).toContain(dataset.summary.verdict.text);
    expect(container.querySelector(".info-popover__panel [data-verdict-text]")).toBeNull();
  });

  it("preview: its prefix is on screen, and so is the estimate chip", () => {
    const dataset = preview();
    expect(dataset.state.kind).toBe("preview");
    const { container } = renderBlock(dataset, () => {});
    const text = container.querySelector("[data-verdict-text]")!;
    expect(text.closest("details")).toBeNull();
    expect(text.textContent).toContain("Local preview, not a finding.");
  });

  it("real, four chains: verdict.text is verbatim in the popover, with the groups and the link", () => {
    const dataset = real();
    expect(dataset.state.kind).toBe("real");
    const { container } = renderBlock(dataset, () => {});
    const panel = container.querySelector(".info-popover__panel")!;
    expect(panel.querySelector("[data-verdict-text]")!.textContent).toContain(
      dataset.summary.verdict.text,
    );
    expect(container.querySelectorAll("[data-verdict-text]")).toHaveLength(1);
    expect(panel.querySelector('a[href="/methodology/#verdict"]')!.textContent).toBe(
      "How we read this",
    );
    for (const item of [
      ...dataset.summary.verdict.facts,
      ...dataset.summary.verdict.estimates,
      ...dataset.summary.verdict.opinions,
    ]) {
      expect(panel.textContent).toContain(item);
    }
  });

  it("the as-of line stays out of the popover, and so do both its texts", () => {
    const dataset = real();
    const { container } = renderBlock(dataset, () => {});
    const line = container.querySelector(".verdict-block__as-of")!;
    expect(line.closest("details")).toBeNull();
    expect(line.textContent).toContain(dataset.state.asOfLine.stale);
    expect(line.textContent).toContain(dataset.state.asOfLine.fresh);
  });

  it("the popover has a name, and joins the page's one-open-at-a-time group", () => {
    const { container } = renderBlock(real(), () => {});
    const summary = container.querySelector("summary")!;
    expect(summary.getAttribute("aria-label")).toBe("About this reading");
    expect(summary.parentElement!.getAttribute("name")).toBe("info");
  });
});

describe("the verdict block", () => {
  it.each(Object.keys(VERDICT_SENTENCES) as (keyof typeof VERDICT_SENTENCES)[])(
    "%s gives its sentence, and verdict.text appears unchanged",
    (state) => {
      const dataset = sample();
      const { container } = renderBlock(dataset, (verdict) => {
        verdict.state = state;
        verdict.text = "Exactly this text, 12% & more.";
      });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(VERDICT_SENTENCES[state]);
      expect(container.querySelector("[data-verdict-text]")!.textContent).toContain(
        "Exactly this text, 12% & more.",
      );
    },
  );

  it("keeps the question line above the sentence", () => {
    const { container } = renderBlock(sample(), () => {});
    const question = container.querySelector('[data-section="question"]')!;
    const heading = screen.getByRole("heading", { level: 1 });
    expect(
      question.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("reads true for moving or mixed with placed just under half and almost no everyday volume", () => {
    // moving needs everyday transfers at 5% a week, so only mixed fits this data
    expect(VERDICT_SENTENCES.mixed).not.toMatch(/^most/i);
    expect(VERDICT_SENTENCES.mixed).toContain("Neither mostly placed nor clearly moving");
    expect(VERDICT_SENTENCES.mixed).not.toMatch(/moving\.|sitting still/);
    // moving claims under half, and the 5% the pipeline's threshold sets
    expect(VERDICT_SENTENCES.moving).toContain("Under half");
    expect(VERDICT_SENTENCES.moving).toContain("at least 5%");
    expect(VERDICT_SENTENCES.moving).not.toMatch(/^Most/);
  });

  it("names the chains at partial scope and never says all chains", () => {
    const partial = sample("partial");
    for (const state of Object.keys(VERDICT_SENTENCES) as (keyof typeof VERDICT_SENTENCES)[]) {
      const text = verdictSentence({ state, scope: partial.summary.verdict.scope });
      expect(text.startsWith("On Tempo and Ethereum: ")).toBe(true);
      expect(text).not.toMatch(/all (four )?chains/i);
    }
    expect(verdictSentence({ state: "mostly_placed", scope: ["base"] })).toBe(
      "On Base: at least half of Open USD (OUSD) supply is sitting still.",
    );
  });

  it("does not claim a majority, as mostly_placed starts at exactly half", () => {
    expect(VERDICT_SENTENCES.mostly_placed).not.toMatch(/\bmost\b/i);
    expect(VERDICT_SENTENCES.mostly_placed).toContain("At least half");
  });

  it("gives an empty scope the unprefixed sentence, never a chain list", () => {
    expect(verdictSentence({ state: "no_clear_statement", scope: [] })).toBe(
      VERDICT_SENTENCES.no_clear_statement,
    );
  });

  it("gives the full-scope sentence no prefix", () => {
    const { scope } = sample().summary.verdict;
    expect(verdictSentence({ state: "mostly_placed", scope })).toBe(
      VERDICT_SENTENCES.mostly_placed,
    );
  });

  it("chips the supporting line Inferred at full scope and Estimate at partial", () => {
    const full = renderBlock(sample(), () => {});
    expect(
      full.container.querySelector("[data-verdict-text] .status-chip .sr-only")!.textContent,
    ).toBe("Inferred");
    full.unmount();
    const partial = renderBlock(sample("partial"), () => {});
    expect(
      partial.container.querySelector("[data-verdict-text] .status-chip .sr-only")!.textContent,
    ).toBe("Estimate");
  });

  it("keeps facts, estimates and opinions apart, and hides an empty group", () => {
    const { container } = renderBlock(sample(), (verdict) => {
      verdict.opinions = [];
    });
    const groups = [...container.querySelectorAll("[data-verdict-group]")].map((el) =>
      el.getAttribute("data-verdict-group"),
    );
    expect(groups).toEqual(["facts", "estimates"]);
    expect(container.textContent).toContain("From the data, by the rules on the methodology page");
    expect(container.textContent).toContain("Depends on an assumption");
    expect(container.textContent).not.toContain("Sample opinion");
    expect(container.textContent).not.toMatch(/\bfacts?\b/i);
  });

  it("shows no group when every group is empty, and keeps the link", () => {
    const { container } = renderBlock(sample(), (verdict) => {
      verdict.facts = [];
      verdict.estimates = [];
      verdict.opinions = [];
    });
    expect(container.querySelector("[data-verdict-group]")).toBeNull();
    expect(container.querySelector('.info-popover__panel a[href$="#verdict"]')).not.toBeNull();
  });

  it("titles the opinion group Our reading on real data", () => {
    const dataset = sample();
    const state = { ...dataset.state, frameWord: null };
    const { container } = render(
      <VerdictBlock verdict={dataset.summary.verdict} kpis={[]} state={state} />,
    );
    expect(
      within(container).getByText("Our reading", { selector: "p.font-semibold" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Our reading").length).toBe(2);
  });

  it("links #verdict", () => {
    const { container } = renderBlock(sample(), () => {});
    const link = container.querySelector('a[href$="#verdict"]');
    expect(link).not.toBeNull();
  });

  it("carries the as-of text and the frame chip", () => {
    const dataset = sample();
    const { container } = renderBlock(dataset, () => {});
    expect(container.textContent).toContain(dataset.state.asOfLine.stale);
    expect(screen.getByText("Sample, not a finding")).toBeTruthy();
  });
});
