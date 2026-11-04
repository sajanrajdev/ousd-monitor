import { useId, type ReactNode } from "react";
import { Accordion } from "./accordion";
import { formatUtcDateTime } from "./chart-theme";
import { HairlineTable, type HairlineTableProps } from "./hairline-table";
import { StatusChip, type ChipKind } from "./status-chip";

// Every prop but `level` is required, so a chart missing its source, time, definition, summary or
// table doesn't compile. The summary and table are server-rendered; Recharts is not.
export type ChartCardProps = {
  takeaway: string;
  chip: ChipKind;
  source: string;
  asOf: string;
  definitionHref: string;
  summary: string;
  table: HairlineTableProps;
  children: ReactNode;
  level?: 2 | 3;
};

export function ChartCard({
  takeaway,
  chip,
  source,
  asOf,
  definitionHref,
  summary,
  table,
  children,
  level = 2,
}: ChartCardProps) {
  const Heading = level === 2 ? "h2" : "h3";
  const headingId = useId();
  return (
    <section className="chart-card" aria-labelledby={headingId}>
      <div className="flex items-start justify-between gap-3">
        <Heading id={headingId} style={{ fontSize: "var(--text-h2)" }}>
          {takeaway}
        </Heading>
        <StatusChip kind={chip} />
      </div>
      <p className="mt-3">{summary}</p>
      {/* aria-hidden and nothing focusable inside; not inert, so hover tooltips still work. */}
      <div className="chart-area mt-4" aria-hidden="true">
        {children}
      </div>
      <noscript>
        <p className="chart-area__needs-js">
          This chart needs JavaScript. The table below has the same data.
        </p>
      </noscript>
      <div className="mt-4">
        <Accordion title="Table of the same data">
          <HairlineTable {...table} />
        </Accordion>
      </div>
      <p className="chart-card__meta mt-3">
        Source: {source} · As of <time dateTime={asOf}>{formatUtcDateTime(asOf)}</time> ·{" "}
        <a href={definitionHref} className="underline underline-offset-4">
          Definition
        </a>
      </p>
    </section>
  );
}
