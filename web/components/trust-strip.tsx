import type { CheckRow, DatasetState, LatestRun, ReconciliationRow } from "@/lib/dataset";
import { CHAIN_NAMES, CHECK_LABELS, definitionHref, REQUIRED_CHAINS } from "@/lib/definitions";
import { formatBaseUnits, UNKNOWN_TEXT } from "@/lib/format";
import { RECONCILIATION_PATH } from "@/lib/site";
import { FreshnessText } from "./freshness";
import { HairlineTable } from "./hairline-table";
import { LinkTip } from "./tooltip";

export type ReconciliationDetailProps = {
  reconciliation: ReconciliationRow[];
  latest_run: LatestRun;
  checks: CheckRow[];
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

// The state, dated, with its marker. The words never move into a tooltip.
function TrustLine({ state }: { state: DatasetState }) {
  return (
    <p className="trust-strip__status">
      <Marker state={state} />
      <FreshnessText fresh={state.trustLine.fresh} stale={state.trustLine.stale} />
    </p>
  );
}

// At the top of the main page whenever the build didn't pass: stale, a failed run, a preview or a
// sample. A passing build says "Reconciled" in the footer instead. The detail is its own page.
export function TrustStrip({ state }: { state: DatasetState }) {
  if (state.passing) return null;
  return (
    <section className="trust-strip" aria-label="Reconciliation" data-section="trust-strip">
      <TrustLine state={state} />
      <a href={RECONCILIATION_PATH} className="target-link underline underline-offset-4">
        Reconciliation detail
      </a>
    </section>
  );
}

// The footer's word for the state, linking to the detail. "Reconciled" in green only on a build that
// passed, with a tick and the word, so it isn't colour alone, and the full sentence as its tooltip. It
// swaps in place if the reader's clock finds the page old. A real build that didn't pass is stale for
// good, and a sample or preview is never reconciled at any age, so each has one text, always shown.
export function FooterStatus({ state }: { state: DatasetState }) {
  const line = (mark: string, text: string) => (
    <span className="footer-status">
      <span aria-hidden="true">{mark}</span>{" "}
      <a href={RECONCILIATION_PATH} className="target-link underline underline-offset-4">
        {text}
      </a>
    </span>
  );
  if (state.kind !== "real") {
    return <p data-footer-status>{line("○", state.trustLine.stale)}</p>;
  }
  const reconciled = state.passing ? (
    <span className="footer-status footer-status--reconciled" data-reconciled>
      <LinkTip
        href={RECONCILIATION_PATH}
        above
        className="target-link gap-1 underline underline-offset-4"
        text={
          <>
            <span aria-hidden="true">✓</span> Reconciled
          </>
        }
      >
        {state.trustLine.fresh}
      </LinkTip>
    </span>
  ) : null;
  return (
    <p data-footer-status>
      <FreshnessText fresh={reconciled} stale={line("▲", state.trustLine.stale)} />
    </p>
  );
}

// Everything the trust row's disclosure used to hold, for /reconciliation/.
export function ReconciliationDetail({
  reconciliation,
  latest_run,
  checks,
  state,
}: ReconciliationDetailProps) {
  const rows = latestRows(reconciliation, latest_run);
  const framed = state.frameWord ? `${state.frameWord} figures, not a reconciliation. ` : "";
  return (
    <section className="reconciliation-detail" data-section="reconciliation">
      <TrustLine state={state} />
      <p>
        <a
          href={definitionHref("reconciliation")}
          className="target-link underline underline-offset-4"
        >
          What this covers
        </a>
      </p>
      <p>
        {framed}
        Reconciliation compares mints minus burns with supply at the block shown. The KPI totals are
        at the close of the named day, so they can differ from these. It doesn&apos;t verify placed
        share or velocity.
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
      <h2 className="reconciliation-detail__checks">Checks before this data was published</h2>
      <ul className="list-disc pl-5">
        {checks.map((check) => (
          <li key={check.name}>
            {(CHECK_LABELS as Record<string, string>)[check.name] ?? check.name}:{" "}
            {check.status === "passed" ? "passed" : "not run"}
          </li>
        ))}
      </ul>
    </section>
  );
}
