import { TableCard } from "@/components/chart-card";
import { SERIES_COLORS } from "@/components/chart-theme";
import { dayRange } from "@/lib/aggregate";
import type { ChainRoleRow, DatasetState } from "@/lib/dataset";
import { CHAIN_NAMES, DAY_ZERO, definitionHref, REQUIRED_CHAINS } from "@/lib/definitions";
import { formatBps, formatCompact, formatUtcDate } from "@/lib/format";
import {
  chainRolesSummary,
  chainRolesTakeaway,
  chainSentences,
  orderedChains,
} from "@/lib/takeaways/chain-roles";

export type ChainRolesViewProps = {
  chain_roles: ChainRoleRow[];
  state: DatasetState;
};

function ChainCell({ chain }: { chain: ChainRoleRow["chain"] }) {
  return (
    <span className="inline-flex items-center gap-2" style={{ whiteSpace: "nowrap" }}>
      <span
        aria-hidden="true"
        data-swatch={chain}
        style={{
          width: "0.75rem",
          height: "0.75rem",
          flex: "none",
          background: SERIES_COLORS[REQUIRED_CHAINS.indexOf(chain)],
          border: "1px solid var(--color-maroon)",
        }}
      />
      {CHAIN_NAMES[chain]}
    </span>
  );
}

function Leads({ row }: { row: ChainRoleRow }) {
  const sentences = chainSentences(row);
  if (sentences.length === 0) return <>None</>;
  return (
    <ul className="list-none p-0" data-leads={row.chain}>
      {sentences.map((sentence) => (
        <li key={sentence}>{sentence}</li>
      ))}
    </ul>
  );
}

// A share of the chain's own activity is read beside its share of supply, so a role that differs
// from plain size shows.
function withShare(amount: string, bps: number | null): string {
  return `${formatCompact(amount)} (${formatBps(bps)})`;
}

export function ChainRolesView({ chain_roles, state }: ChainRolesViewProps) {
  const rows = orderedChains(chain_roles);
  return (
    <section id="chain-roles-view" data-section="view-e">
      <TableCard
        takeaway={chainRolesTakeaway(chain_roles)}
        chip="inferred"
        source="Chain data and public labels"
        asOf={dayRange(chain_roles.map((row) => row.as_of_day)) ?? DAY_ZERO}
        definitionHref={definitionHref("chain-roles")}
        frameWord={state.frameWord}
        summary={chainRolesSummary(chain_roles)}
        table={{
          caption: "Chain roles: share of supply beside each share of activity",
          columns: [
            { key: "chain", label: "Chain" },
            { key: "supply", label: "Share of supply", numeric: true },
            { key: "placed", label: "Placed share of chain", numeric: true },
            { key: "minted", label: "Minted, 30 days", numeric: true },
            { key: "burned", label: "Burned, 30 days", numeric: true },
            { key: "everyday", label: "Clean everyday, 30 days (share)", numeric: true },
            { key: "dex", label: "DEX flow, 30 days (share)", numeric: true },
            { key: "lending", label: "Lending flow, 30 days", numeric: true },
            { key: "day", label: "As of" },
            { key: "leads", label: "Leads on" },
          ],
          rows: rows.map((row) => ({
            chain: <ChainCell chain={row.chain} />,
            supply: formatBps(row.supply_share_bps),
            placed: formatBps(row.placed_share_of_chain_bps),
            minted: formatCompact(row.minted_30d),
            burned: formatCompact(row.burned_30d),
            everyday: withShare(row.clean_everyday_30d, row.clean_everyday_share_bps),
            dex: withShare(row.dex_flow_30d, row.dex_flow_share_bps),
            lending: formatCompact(row.lending_flow_30d),
            day: formatUtcDate(row.as_of_day),
            leads: <Leads row={row} />,
          })),
        }}
        note={
          <p data-note="no-swaps">
            We don&rsquo;t ingest swaps, so this view can&rsquo;t show trading.{" "}
            <a href={definitionHref("chain-roles")} className="underline underline-offset-4">
              How these are defined
            </a>
          </p>
        }
      />
    </section>
  );
}
