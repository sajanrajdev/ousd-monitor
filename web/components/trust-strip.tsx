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

// What a run covers, and what it doesn't, in one sentence.
export const COVERS =
  "Each run compares every chain's mints minus burns with its supply, and their sum with Bridge's total; it doesn't check placed share or velocity.";

// The state, dated, with its marker. The words never move into a tooltip.
function TrustLine({ state }: { state: DatasetState }) {
  return (
    <p className="trust-strip__status">
      <Marker state={state} />
      <FreshnessText fresh={state.trustLine.fresh} stale={state.trustLine.stale} />
    </p>
  );
}

// At the top of the main page on sample or preview data, or when a newer run failed its checks. Real
// data that is only old says so in the footer instead. The detail is its own page.
export function TrustStrip({ state }: { state: DatasetState }) {
  if (state.staleInFooter) return null;
  return (
    <section className="trust-strip" aria-label="Reconciliation" data-section="trust-strip">
      <TrustLine state={state} />
      <a href={RECONCILIATION_PATH} className="target-link underline underline-offset-4">
        Reconciliation detail
      </a>
    </section>
  );
}

// Drawn, so each state has a shape as well as a colour, and the label beside it says it in words.
function StatusIcon({ shape }: { shape: "check" | "clock" }) {
  return (
    <svg
      className="footer-status__icon"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
    >
      {shape === "check" ? (
        <path d="M2.5 7.5 5.5 10.5 11.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" />
      ) : (
        <>
          <circle cx="7" cy="7" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 3.75V7h2.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}

// The footer's word for the state, linking to the detail, with the full sentence as its tooltip. A
// green tick and "Reconciled" only on a build that passed. Once the reader's clock finds it old, or
// on real data that was old when built, an amber clock and "Last reconciled" with the day: never
// "Reconciled" alone. A sample or preview is never reconciled at any age, so it has one text.
export function FooterStatus({ state }: { state: DatasetState }) {
  if (state.kind !== "real") {
    return (
      <p data-footer-status>
        <span className="footer-status">
          <span aria-hidden="true">○</span>{" "}
          <a href={RECONCILIATION_PATH} className="target-link underline underline-offset-4">
            {state.trustLine.stale}
          </a>
        </span>
      </p>
    );
  }
  const status = (variant: "reconciled" | "stale", text: string, tip: string) => (
    <span
      className={`footer-status footer-status--${variant}`}
      data-reconciled={variant === "reconciled" ? "" : undefined}
      data-stale-status={variant === "stale" ? "" : undefined}
    >
      <LinkTip
        href={RECONCILIATION_PATH}
        above
        align="end"
        className="target-link gap-1.5 underline underline-offset-4"
        text={
          <>
            <StatusIcon shape={variant === "reconciled" ? "check" : "clock"} />
            {text}
          </>
        }
      >
        {tip}
      </LinkTip>
    </span>
  );
  const reconciled =
    state.passing && state.trustLine.fresh
      ? status("reconciled", "Reconciled", state.trustLine.fresh)
      : null;
  return (
    <p data-footer-status>
      <FreshnessText
        fresh={reconciled}
        stale={status("stale", state.trustLine.short, state.trustLine.stale)}
      />
    </p>
  );
}

// The detail behind the footer's status: one line on the latest run, what it covers, the run's
// figures and the checks before publishing.
export function ReconciliationDetail({
  reconciliation,
  latest_run,
  checks,
  state,
}: ReconciliationDetailProps) {
  const rows = latestRows(reconciliation, latest_run);
  return (
    <section className="reconciliation-detail" data-section="reconciliation">
      <p className="reconciliation-detail__status" data-run-line>
        <FreshnessText fresh={state.runLine.fresh} stale={state.runLine.stale} />
      </p>
      <p>
        {COVERS}{" "}
        <a
          href={definitionHref("reconciliation")}
          className="target-link underline underline-offset-4"
        >
          How it works
        </a>
      </p>
      {rows.length > 0 ? (
        <HairlineTable
          caption="Latest run, in base units (1 OUSD is 1,000,000), at each chain's block"
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
      <h2 className="reconciliation-detail__checks">Checks before publishing</h2>
      <dl className="check-list" data-check-list>
        {checks.map((check) => (
          <div key={check.name} className="check-list__row">
            <dt>{(CHECK_LABELS as Record<string, string>)[check.name] ?? check.name}</dt>
            <dd data-check-status={check.status}>
              {check.status === "passed" ? "Passed" : "Not run"}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
