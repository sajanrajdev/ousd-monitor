import type { ChainRoleRow } from "../../lib/dataset/index.ts";
import type { Expected } from "./expected.ts";
import { CARD_ANCHORS, CHAIN_NAMES } from "../../lib/definitions.ts";
import { formatBps, formatCompact } from "../../lib/format.ts";
import { inView, viewText } from "./dom.ts";

// What the chain grid must print, worked out here from the chain roles rows: a bar scales to the
// amount a lead is measured on (publish.py's _LEADING_MEASURES), and the lead marker is the dataset's.
type GridField = {
  measure: ChainRoleRow["leading_for"][number];
  amount:
    "total_supply" | "minted_30d" | "clean_everyday_30d" | "dex_flow_30d" | "lending_flow_30d";
  share: "supply_share_bps" | "clean_everyday_share_bps" | "dex_flow_share_bps" | "";
  showAmount: boolean;
};
const GRID_FIELDS: GridField[] = [
  { measure: "supply", amount: "total_supply", share: "supply_share_bps", showAmount: false },
  { measure: "issuance", amount: "minted_30d", share: "", showAmount: true },
  {
    measure: "everyday",
    amount: "clean_everyday_30d",
    share: "clean_everyday_share_bps",
    showAmount: true,
  },
  { measure: "dex_flow", amount: "dex_flow_30d", share: "dex_flow_share_bps", showAmount: true },
  { measure: "lending_flow", amount: "lending_flow_30d", share: "", showAmount: true },
];

export function gridExpected(roles: ChainRoleRow[]) {
  const order = Object.keys(CHAIN_NAMES);
  const rows = [...roles].sort((a, b) => order.indexOf(a.chain) - order.indexOf(b.chain));
  return {
    rows: GRID_FIELDS.map(({ measure, amount, share, showAmount }) => {
      const amounts = rows.map((row) => BigInt(row[amount]));
      const largest = amounts.reduce((top, value) => (value > top ? value : top), 0n);
      return {
        measure,
        cells: rows.map((row, index) => {
          const shared = share ? formatBps(row[share]) : "";
          return {
            chain: row.chain,
            text: showAmount
              ? `${formatCompact(amounts[index])}${shared ? ` (${shared})` : ""}`
              : shared,
            widthBps:
              largest > 0n && amounts[index] > 0n
                ? Number((amounts[index] * 10_000n) / largest)
                : 0,
            leads: row.leading_for.includes(measure),
          };
        }),
      };
    }),
  };
}

// The chain grid: a real table in view, each cell's figure, bar width and lead marker as the dataset
// gives them, and the as-of row only when the chains' days differ.
export function checkGrid(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  if (!expected.grid) return;
  const card = document.querySelector(`[id="${CARD_ANCHORS.chainRoles}"]`);
  const where = `${page}: #${CARD_ANCHORS.chainRoles}`;
  const grid = card?.querySelector("table[data-chain-grid]");
  if (!grid || !inView(grid) || grid.closest("[aria-hidden], details, noscript")) {
    problems.push(`${where}: its grid isn't in view`);
    return;
  }
  const said = [...grid.querySelectorAll<HTMLElement>("tbody tr[data-grid-measure]")]
    .filter((row) => row.dataset.gridMeasure !== "as-of")
    .flatMap((row) =>
      [...row.querySelectorAll<HTMLElement>("td[data-grid-chain]")].map(
        (cell) =>
          `${row.dataset.gridMeasure}:${cell.dataset.gridChain}=${viewText(cell.querySelector("[data-grid-value]"), "").replace(/\s+/g, " ").trim()}@${cell.querySelector<HTMLElement>(".chain-grid__bar")?.dataset.width}${cell.hasAttribute("data-leads") ? "*" : ""}`,
      ),
    );
  const want = expected.grid.rows.flatMap((row) =>
    row.cells.map(
      (cell) =>
        `${row.measure}:${cell.chain}=${cell.text}@${cell.widthBps}${cell.leads ? "*" : ""}`,
    ),
  );
  if (said.join() !== want.join()) problems.push(`${where}: its grid isn't the dataset's`);
}
