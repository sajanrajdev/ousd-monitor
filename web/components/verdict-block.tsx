import type { DatasetState, KpiRow, Verdict } from "@/lib/dataset";
import { definitionHref } from "@/lib/definitions";
import { UNKNOWN_TEXT } from "@/lib/format";
import { FreshnessText } from "./freshness";
import { StatusChip } from "./status-chip";

export type VerdictBlockProps = {
  verdict: Verdict;
  kpis: KpiRow[];
  state: DatasetState;
};

// A stub until unit 3.2. The question line, the chip's wording and the as-of line stay.
export function VerdictBlock({ state }: VerdictBlockProps) {
  return (
    <section className="verdict-block" data-section="verdict">
      <p data-section="question">
        Open USD (OUSD) pays partners to distribute it. Is that turning into money that moves?
      </p>
      <h1 style={{ fontSize: "var(--text-display)" }}>{UNKNOWN_TEXT}</h1>
      <p className="mt-3">
        <StatusChip kind="opinion" frameWord={state.frameWord} />{" "}
        <a href={definitionHref("verdict")} className="underline underline-offset-4">
          How we read this
        </a>
      </p>
      <p className="mt-3">
        <FreshnessText fresh={state.asOfLine.fresh} stale={state.asOfLine.stale} />
      </p>
    </section>
  );
}
