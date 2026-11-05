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
    expect(heading.closest("details, .tip__panel")).toBeNull();
    expect(heading.hasAttribute("style")).toBe(false);
    // No "Our reading" tag, and on real data no frame words either.
    expect(container.querySelector(".status-chip")).toBeNull();
    expect(container.querySelector("[data-verdict-frame]")).toBeNull();
    const shown = container.querySelector('[data-section="verdict"]')!.cloneNode(true) as Element;
    for (const panel of shown.querySelectorAll(".tip__panel")) panel.remove();
    expect(shown.textContent).not.toContain("Our reading");
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
    expect(text.closest("details, .tip__panel")).toBeNull();
    expect(text.textContent).toContain(dataset.summary.verdict.text);
    expect(container.querySelector(".tip__panel [data-verdict-text]")).toBeNull();
  });

  it("preview: its prefix is on screen, and so is the frame's warning, in plain words", () => {
    const dataset = preview();
    expect(dataset.state.kind).toBe("preview");
    const { container } = renderBlock(dataset, () => {});
    const text = container.querySelector("[data-verdict-text]")!;
    expect(text.closest("details, .tip__panel")).toBeNull();
    const frame = container.querySelector("[data-verdict-frame]")!;
    expect(frame.textContent).toBe("Preview, not a finding.");
    expect(frame.closest(".tip__panel")).toBeNull();
    expect(frame.classList.contains("status-chip")).toBe(false);
    expect(text.textContent).toContain("Local preview, not a finding.");
  });

  it("real, four chains: verdict.text is verbatim in the tooltip, with the groups and the link", () => {
    const dataset = real();
    expect(dataset.state.kind).toBe("real");
    const { container } = renderBlock(dataset, () => {});
    const panel = container.querySelector(".tip__panel")!;
    expect(panel.querySelector("[data-verdict-text]")!.textContent).toContain(
      dataset.summary.verdict.text,
    );
    expect(container.querySelectorAll("[data-verdict-text]")).toHaveLength(1);
    expect(panel.querySelector('a[href="/methodology/#verdict"]')).not.toBeNull();
    for (const item of [
      ...dataset.summary.verdict.facts,
      ...dataset.summary.verdict.estimates,
      ...dataset.summary.verdict.opinions,
    ]) {
      expect(panel.textContent).toContain(item);
    }
  });

  it("the as-of line stays out of the tooltip, and so do both its texts", () => {
    const dataset = real();
    expect(dataset.state.passing).toBe(true);
    const { container } = renderBlock(dataset, () => {});
    const line = container.querySelector(".verdict-block__as-of")!;
    expect(line.closest("details, .tip__panel")).toBeNull();
    // A passing build has no trust row at the top, so its stale text says when it was reconciled.
    expect(dataset.state.headStale).toContain("Last reconciled");
    expect(line.textContent).toContain(dataset.state.headStale);
    expect(line.textContent).toContain(dataset.state.asOfLine.fresh);
  });

  it("keeps the as-of line's plain stale text when the trust row is at the top", () => {
    const dataset = sample();
    expect(dataset.state.passing).toBe(false);
    expect(dataset.state.headStale).toBe(dataset.state.asOfLine.stale);
  });

  it("'How we read this' is a disclosure tooltip, with the reading inside it", () => {
    const { container } = renderBlock(real(), () => {});
    const trigger = screen.getByRole("button", { name: "How we read this" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(panel.classList.contains("tip__panel")).toBe(true);
    expect(panel.querySelector("[data-verdict-group]")).not.toBeNull();
    expect(container.querySelector("details")).toBeNull();
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

  it("has no question line above the sentence, as the second review removed it", () => {
    const { container } = renderBlock(sample(), () => {});
    expect(container.querySelector('[data-section="question"]')).toBeNull();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.closest('[data-section="verdict"]')!.firstElementChild!.contains(heading)).toBe(
      true,
    );
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

  it("puts no marker on the supporting line, at full scope or partial", () => {
    for (const name of ["complete", "partial"] as const) {
      const { container, unmount } = renderBlock(sample(name), () => {});
      expect(container.querySelector("[data-verdict-text]")).not.toBeNull();
      expect(container.querySelector(".status-chip")).toBeNull();
      unmount();
    }
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
    expect(container.querySelector('.tip__panel a[href$="#verdict"]')).not.toBeNull();
  });

  it("titles the opinion group Our reading on real data", () => {
    const dataset = sample();
    const state = { ...dataset.state, frameWord: null };
    const { container } = render(
      <VerdictBlock verdict={dataset.summary.verdict} kpis={[]} state={state} />,
    );
    // Only the group's title, in the tooltip: the headline no longer carries the tag.
    const title = within(container).getByText("Our reading");
    expect(title.closest(".tip__panel")).not.toBeNull();
    expect(screen.getAllByText("Our reading").length).toBe(1);
  });

  it("links #verdict", () => {
    const { container } = renderBlock(sample(), () => {});
    const link = container.querySelector('a[href$="#verdict"]');
    expect(link).not.toBeNull();
  });

  it("carries the as-of text and the frame's warning, as plain text beside the headline", () => {
    const dataset = sample();
    const { container } = renderBlock(dataset, () => {});
    expect(container.textContent).toContain(dataset.state.asOfLine.stale);
    const frame = screen.getByText("Sample, not a finding.");
    expect(frame.closest(".verdict-block__head")).not.toBeNull();
    expect(frame.closest(".status-chip, .tip__panel")).toBeNull();
  });
});
