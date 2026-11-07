import type { ReactNode } from "react";

// A native details element: it opens by tap, click and keyboard with no script, and the table is in
// the server-rendered HTML. CSS swaps the words and, from the card, the plot for the table. Never the
// only copy of a finding or a caveat.
export function DataToggle({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="data-toggle">
      <summary>
        <span className="data-toggle__to-table">Table</span>
        <span className="data-toggle__to-chart">Chart</span>
        <span className="sr-only"> for {label}</span>
      </summary>
      <div className="data-toggle__panel">{children}</div>
    </details>
  );
}
