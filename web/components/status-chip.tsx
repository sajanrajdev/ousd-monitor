import type { FrameWord } from "@/lib/dataset/state";

export type ChipKind = "fact" | "estimate" | "inferred" | "opinion";

const LABELS: Record<ChipKind, string> = {
  fact: "Fact",
  estimate: "Estimate",
  inferred: "Inferred",
  opinion: "Our reading",
};

// The label carries the meaning; the outline style is only a second cue. On sample or preview data
// an opinion isn't one, so `frameWord` replaces "Our reading" and nothing else.
export function StatusChip({
  kind,
  frameWord = null,
}: {
  kind: ChipKind;
  frameWord?: FrameWord | null;
}) {
  return (
    <span className="status-chip" data-kind={kind}>
      {kind === "opinion" && frameWord ? `${frameWord}, not a finding` : LABELS[kind]}
    </span>
  );
}
