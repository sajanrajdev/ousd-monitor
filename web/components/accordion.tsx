import type { ReactNode } from "react";

// A native details element: keyboard and screen reader behaviour for free, and the content is
// in the server-rendered HTML even when closed.
export function Accordion({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="accordion" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="pb-4">{children}</div>
    </details>
  );
}
