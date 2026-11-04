// The verdict's display sentence and how its supporting lists are grouped. Each sentence states only
// what its state's conditions establish, so a change in the data can't make one false.
import type { Verdict } from "./dataset/rows.ts";
import type { DatasetState, FrameWord } from "./dataset/state.ts";
import { CHAIN_NAMES, REQUIRED_CHAINS } from "./definitions.ts";

type VerdictState = Verdict["state"];
type Scope = Verdict["scope"];

// "At least half", not "most": the pipeline assigns mostly_placed at exactly 50.00% placed.
// For the maintainer's review. Placed below 50% and everyday transfers at 5% of supply a week are
// the pipeline's thresholds (PLACED_THRESHOLD_BPS and EVERYDAY_THRESHOLD_BPS).
export const VERDICT_SENTENCES: Record<VerdictState, string> = {
  mostly_placed: "At least half of Open USD (OUSD) supply is sitting still.",
  moving:
    "Under half of Open USD (OUSD) supply is sitting still, and everyday transfers are at least 5% of supply a week.",
  mixed:
    "Neither mostly placed nor clearly moving: the data doesn't support a clear statement on Open USD (OUSD) yet.",
  no_clear_statement: "The data doesn't support a clear statement on Open USD (OUSD) yet.",
};

export function chainList(scope: Scope): string {
  const names = scope.map((chain) => CHAIN_NAMES[chain]);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function isFullScope(scope: Scope): boolean {
  return REQUIRED_CHAINS.every((chain) => scope.includes(chain));
}

// At partial scope the sentence names its chains, and never speaks for the rest.
export function verdictSentence({ state, scope }: Pick<Verdict, "state" | "scope">): string {
  const sentence = VERDICT_SENTENCES[state];
  if (isFullScope(scope) || scope.length === 0) return sentence;
  return `On ${chainList(scope)}: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

// The supporting line states rule-based numbers. At partial scope it also states an estimated share
// of OUSD on the chains covered, so it carries the weaker chip.
export function supportingChip({ scope }: Pick<Verdict, "scope">): "inferred" | "estimate" {
  return isFullScope(scope) ? "inferred" : "estimate";
}

// On a preview, a sample or a partial scope, verdict.text carries "Local preview, not a finding." or
// the estimated share, so it stays on screen. It moves to the popover only on real, four-chain data.
export function verdictTextVisible(
  { scope }: Pick<Verdict, "scope">,
  { kind }: Pick<DatasetState, "kind">,
): boolean {
  return !(kind === "real" && isFullScope(scope));
}

export type VerdictGroup = {
  key: "facts" | "estimates" | "opinions";
  title: string;
  items: string[];
};

// Empty groups are left out. The first title avoids the word "fact", because `facts` includes
// rule-based figures that the page chips as Inferred. On sample or preview data an opinion isn't
// one, so its title says that instead of "Our reading".
export function verdictGroups(verdict: Verdict, frameWord: FrameWord | null): VerdictGroup[] {
  const groups: VerdictGroup[] = [
    {
      key: "facts",
      title: "From the data, by the rules on the methodology page",
      items: verdict.facts,
    },
    { key: "estimates", title: "Depends on an assumption", items: verdict.estimates },
    {
      key: "opinions",
      title: frameWord ? `${frameWord} opinion` : "Our reading",
      items: verdict.opinions,
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}
