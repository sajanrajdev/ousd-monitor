import type { FrameWord } from "@/lib/dataset/state";

export type ChipKind = "fact" | "estimate" | "inferred" | "opinion";

export const MARKERS: Record<Exclude<ChipKind, "opinion">, { letter: string; word: string }> = {
  fact: { letter: "F", word: "Fact" },
  inferred: { letter: "I", word: "Inferred" },
  estimate: { letter: "E", word: "Estimate" },
};

// The letter carries the meaning, the outline style is only a second cue, and the full word is in
// the DOM for assistive tech. An opinion stays in words, and on sample or preview data it isn't one,
// so `frameWord` replaces "Our reading" and nothing else.
export function StatusChip({
  kind,
  frameWord = null,
}: {
  kind: ChipKind;
  frameWord?: FrameWord | null;
}) {
  if (kind === "opinion") {
    return (
      <span className="status-chip" data-kind={kind}>
        {frameWord ? `${frameWord}, not a finding` : "Our reading"}
      </span>
    );
  }
  const { letter, word } = MARKERS[kind];
  return (
    <span className="status-chip" data-kind={kind}>
      <span aria-hidden="true">{letter}</span>
      <span className="sr-only">{word}</span>
    </span>
  );
}
