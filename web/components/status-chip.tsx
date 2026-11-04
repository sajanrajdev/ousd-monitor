export type ChipKind = "fact" | "estimate" | "inferred" | "opinion";

const LABELS: Record<ChipKind, string> = {
  fact: "Fact",
  estimate: "Estimate",
  inferred: "Inferred",
  opinion: "Our reading",
};

// The label carries the meaning; the outline style is only a second cue.
export function StatusChip({ kind }: { kind: ChipKind }) {
  return (
    <span className="status-chip" data-kind={kind}>
      {LABELS[kind]}
    </span>
  );
}
