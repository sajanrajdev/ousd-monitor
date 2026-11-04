import type { ReactNode } from "react";

// A native details element, so it opens by tap and keyboard with no script, and the content is in
// the server-rendered HTML. `name` keeps one open at a time. Hover and Escape come from
// ExplainEnhance. Sits in an `explain-head`, which reserves the corner its trigger goes in. Never for
// a finding, a caveat needed to read a number, or a stale, sample, preview or partial message.
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="info-popover" name="info">
      <summary aria-label={label} />
      <div className="info-popover__panel">{children}</div>
    </details>
  );
}
