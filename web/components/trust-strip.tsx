import type { CheckRow, Coverage, DatasetState, LatestRun, ReconciliationRow } from "@/lib/dataset";
import { CHAIN_NAMES, CHECK_LABELS, definitionHref, REQUIRED_CHAINS } from "@/lib/definitions";
import { formatBaseUnits, UNKNOWN_TEXT } from "@/lib/format";
import { Accordion } from "./accordion";
import { FreshnessText } from "./freshness";
import { HairlineTable } from "./hairline-table";

export type TrustStripProps = {
  reconciliation: ReconciliationRow[];
  latest_run: LatestRun;
  checks: CheckRow[];
  coverage: Coverage;
  state: DatasetState;
};

// Chain rows in the site's chain order, then Bridge's comparison, from the latest run alone.
function latestRows(rows: ReconciliationRow[], latest: LatestRun): ReconciliationRow[] {
  if (!latest) return [];
  const chains = REQUIRED_CHAINS.flatMap((chain) =>
    rows.filter(
      (row) => row.kind === "chain" && row.subject === chain && row.run_id === latest.run_id,
    ),
  );
  return [...chains, ...rows.filter((row) => row.kind === "bridge" && row.in_latest_run === true)];
}

function subjectLabel(row: ReconciliationRow): string {
  if (row.kind === "bridge") return "Bridge's reported total, all chains";
  return CHAIN_NAMES[row.subject as keyof typeof CHAIN_NAMES] ?? row.subject;
}

// A shape as well as words, so the states differ without colour: a tick, a warning triangle, and a
// ring where nothing was reconciled. It shares the sentence's fresh and stale swap.
function Marker({ state }: { state: DatasetState }) {
  if (state.kind !== "real") return <span aria-hidden="true">○</span>;
  return (
    <span aria-hidden="true">
      <FreshnessText fresh={state.trustLine.fresh === null ? null : "✓"} stale="▲" />
    </span>
  );
}

export function TrustStrip({ reconciliation, latest_run, checks, state }: TrustStripProps) {
  const rows = latestRows(reconciliation, latest_run);
  const framed = state.frameWord ? `${state.frameWord} figures, not a reconciliation. ` : "";
  return (
    <section className="trust-strip" aria-label="Reconciliation" data-section="trust-strip">
      <p>
        <Marker state={state} />{" "}
        <FreshnessText fresh={state.trustLine.fresh} stale={state.trustLine.stale} />{" "}
        <a href={definitionHref("reconciliation")} className="underline underline-offset-4">
          What this covers
        </a>
      </p>
      <Accordion title="Reconciliation detail">
        <p>
          {framed}
          Reconciliation compares mints minus burns with supply at the block shown. The KPI totals
          are at the close of the named day, so they can differ from these. It doesn&apos;t verify
          placed share or velocity.
        </p>
        {rows.length > 0 ? (
          <HairlineTable
            caption="Latest reconciliation run, in base units (1 OUSD is 1,000,000)"
            columns={[
              { key: "subject", label: "Compared" },
              { key: "block", label: "Block", numeric: true },
              { key: "event", label: "Event total", numeric: true },
              { key: "reference", label: "Reference total", numeric: true },
              { key: "difference", label: "Difference", numeric: true },
              { key: "result", label: "Result" },
            ]}
            rows={rows.map((row) => ({
              subject: subjectLabel(row),
              block: row.block_number === null ? "Not applicable" : String(row.block_number),
              event: formatBaseUnits(row.event_value),
              reference: formatBaseUnits(row.reference_value),
              difference: formatBaseUnits(row.difference),
              result: row.passed ? "Matched" : "Did not match",
            }))}
          />
        ) : (
          <p>{UNKNOWN_TEXT}</p>
        )}
        <p className="mt-4 font-semibold">Checks before this data was published</p>
        <ul className="list-disc pl-5">
          {checks.map((check) => (
            <li key={check.name}>
              {(CHECK_LABELS as Record<string, string>)[check.name] ?? check.name}:{" "}
              {check.status === "passed" ? "passed" : "not run"}
            </li>
          ))}
        </ul>
      </Accordion>
    </section>
  );
}
