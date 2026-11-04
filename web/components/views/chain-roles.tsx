import { TableCard } from "@/components/chart-card";
import { dayRange } from "@/lib/aggregate";
import type { ChainRoleRow, DatasetState } from "@/lib/dataset";
import { CHAIN_NAMES, DAY_ZERO, definitionHref } from "@/lib/definitions";
import { formatUtcDate, UNKNOWN_TEXT } from "@/lib/format";

export type ChainRolesViewProps = {
  chain_roles: ChainRoleRow[];
  state: DatasetState;
};

// A stub until unit 3.3c.
export function ChainRolesView({ chain_roles, state }: ChainRolesViewProps) {
  return (
    <section id="chain-roles-view" data-section="view-e">
      <TableCard
        takeaway={UNKNOWN_TEXT}
        chip="inferred"
        source="Chain data and public labels"
        asOf={dayRange(chain_roles.map((row) => row.as_of_day)) ?? DAY_ZERO}
        definitionHref={definitionHref("chain-roles")}
        frameWord={state.frameWord}
        summary={UNKNOWN_TEXT}
        table={{
          caption: "Chains and their as-of days",
          columns: [
            { key: "chain", label: "Chain" },
            { key: "day", label: "As of" },
          ],
          rows: chain_roles.map((row) => ({
            chain: CHAIN_NAMES[row.chain],
            day: formatUtcDate(row.as_of_day),
          })),
        }}
      />
    </section>
  );
}
