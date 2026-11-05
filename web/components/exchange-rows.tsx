import type { ExchangeRow } from "@/lib/exchange-rows";

// Each name has its source beside it, and verify-output allows the name nowhere else on this page.
export function ExchangeRows({ rows }: { rows: ExchangeRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="mt-2" data-exchange-rows>
      {rows.map((row, index) => (
        <li key={index} data-exchange-row>
          <span data-exchange-name>{row.entity}</span>,{" "}
          <span data-exchange-detail>{row.detail}</span>. Source:{" "}
          <a
            href={row.sourceHref}
            rel={row.sourceHref.startsWith("https://") ? "noopener noreferrer" : undefined}
            className="underline underline-offset-4"
            data-exchange-source
          >
            {row.sourceText}
          </a>
          .
        </li>
      ))}
    </ul>
  );
}
