import type { CheckRow, Coverage, DatasetState, LatestRun, ReconciliationRow } from "@/lib/dataset";
import { definitionHref } from "@/lib/definitions";
import { FreshnessText } from "./freshness";

export type TrustStripProps = {
  reconciliation: ReconciliationRow[];
  latest_run: LatestRun;
  checks: CheckRow[];
  coverage: Coverage;
  state: DatasetState;
};

// A stub until unit 3.2, which adds the detail. Its sentence already comes from the state, so sample
// and preview data read "Not reconciled" from the first build.
export function TrustStrip({ state }: TrustStripProps) {
  return (
    <section className="trust-strip" aria-label="Reconciliation" data-section="trust-strip">
      <FreshnessText fresh={state.trustLine.fresh} stale={state.trustLine.stale} />{" "}
      <a href={definitionHref("reconciliation")} className="underline underline-offset-4">
        What this covers
      </a>
    </section>
  );
}
