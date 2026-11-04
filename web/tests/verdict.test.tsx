import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerdictBlock } from "@/components/verdict-block";
import { loadDataset, type Dataset } from "@/lib/dataset/load";
import { VERDICT_SENTENCES, verdictSentence } from "@/lib/verdict";
import { at, copySample } from "./dataset-helpers";

const SOON = Date.parse("2026-11-04T08:00:00Z");

function sample(name: "complete" | "partial" = "complete"): Dataset {
  return loadDataset(at(copySample(name)), { now: SOON });
}

function renderBlock(dataset: Dataset, change: (verdict: Dataset["summary"]["verdict"]) => void) {
  const verdict = structuredClone(dataset.summary.verdict);
  change(verdict);
  return render(
    <VerdictBlock verdict={verdict} kpis={dataset.summary.kpis} state={dataset.state} />,
  );
}

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

  it("hides the accordion when every group is empty", () => {
    const { container } = renderBlock(sample(), (verdict) => {
      verdict.facts = [];
      verdict.estimates = [];
      verdict.opinions = [];
    });
    expect(container.querySelector("details")).toBeNull();
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
