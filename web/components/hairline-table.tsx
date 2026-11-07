import type { ReactNode } from "react";

export type TableColumn = { key: string; label: string; numeric?: boolean };

export type HairlineTableProps = {
  caption: string;
  columns: TableColumn[];
  rows: Record<string, ReactNode>[];
};

export function HairlineTable({ caption, columns, rows }: HairlineTableProps) {
  return (
    <table className="hairline-table" role="table">
      <caption>{caption}</caption>
      <thead role="rowgroup">
        <tr role="row">
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              role="columnheader"
              data-numeric={column.numeric || undefined}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody role="rowgroup">
        {rows.map((row, index) => (
          <tr key={index} role="row">
            {columns.map((column) => (
              <td
                key={column.key}
                role="cell"
                data-label={column.label}
                data-numeric={column.numeric || undefined}
              >
                {row[column.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
