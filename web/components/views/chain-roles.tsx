import { ChartCard } from "@/components/chart-card";
import { PinMark, type PinnedNote } from "@/components/pinned-notes";
import { chainGrid } from "@/lib/chain-views";
import { SERIES_COLORS } from "@/components/chart-theme";
import { dayRange } from "@/lib/aggregate";
import type {
  ChainRoleRow,
  Definitions,
  DatasetState,
  KpiRow,
  ManifestWarning,
} from "@/lib/dataset";
import {
  CARD_ANCHORS,
  CHAIN_NAMES,
  DAY_ZERO,
  definitionHref,
  REQUIRED_CHAINS,
} from "@/lib/definitions";
import { formatBps, formatCompact, formatUtcDate, UNKNOWN_TEXT } from "@/lib/format";
import { NO_SWAPS_NOTE } from "@/lib/takeaways/caveats";
import {
  chainRolesHeading,
  chainRolesSummary,
  chainRolesTakeaway,
  chainSentences,
  differingDays,
  orderedChains,
} from "@/lib/takeaways/chain-roles";
import { VelocityCard } from "./velocity";

export type ChainRolesViewProps = {
  chain_roles: ChainRoleRow[];
  kpis: KpiRow[];
  definitions: Definitions;
  warnings: ManifestWarning[];
  state: DatasetState;
};

const LEAD_MARK = "●";

// Measures as rows and chains as columns. A real table, with words for assistive tech, so it is the
// card's content rather than a hidden graphic. Each cell's bar scales to its row's largest amount,
// and prints nothing the dataset doesn't give.
function ChainGrid({ rows, pin }: { rows: ChainRoleRow[]; pin: number }) {
  const grid = chainGrid(rows);
  const ordered = orderedChains(rows);
  return (
    <table className="chain-grid" data-chain-grid>
      <caption>
        Last 30 days, each chain on its newest day. <span aria-hidden="true">{LEAD_MARK}</span>{" "}
        leads that measure. <PinMark number={pin} />
      </caption>
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Measure</span>
          </th>
          {grid.chains.map((chain) => (
            <th key={chain} scope="col" data-grid-chain={chain}>
              <ChainCell chain={chain} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {grid.rows.map((row) => (
          <tr key={row.measure} data-grid-measure={row.measure}>
            <th scope="row">{row.label}</th>
            {row.cells.map((cell) => (
              <td
                key={cell.chain}
                data-grid-chain={cell.chain}
                data-label={CHAIN_NAMES[cell.chain]}
                data-leads={cell.leads || undefined}
              >
                <div className="chain-grid__cell">
                  <span className="chain-grid__value">
                    <span data-grid-value>
                      {cell.text.split(" (").map((part, index) => (
                        <span key={part} className="chain-grid__part">
                          {index === 0 ? part : ` (${part}`}
                        </span>
                      ))}
                    </span>
                    {cell.leads ? (
                      <span className="chain-grid__lead">
                        <span aria-hidden="true">{LEAD_MARK}</span>
                        <span className="sr-only">{`, leads: ${row.lead}`}</span>
                      </span>
                    ) : null}
                  </span>
                  <span
                    aria-hidden="true"
                    className="chain-grid__bar"
                    data-width={cell.widthBps}
                    style={{ width: `${cell.widthBps / 100}%` }}
                  />
                </div>
              </td>
            ))}
          </tr>
        ))}
        {differingDays(rows) ? (
          <tr data-grid-measure="as-of">
            <th scope="row">As of</th>
            {ordered.map((row) => (
              <td key={row.chain} data-grid-chain={row.chain} data-label={CHAIN_NAMES[row.chain]}>
                {formatUtcDate(row.as_of_day)}
              </td>
            ))}
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

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

export function ChainRolesView({
  chain_roles,
  kpis,
  definitions,
  warnings,
  state,
}: ChainRolesViewProps) {
  const rows = orderedChains(chain_roles);
  const notes: PinnedNote[] = [
    {
      kind: "no-swaps",
      text: (
        <>
          {NO_SWAPS_NOTE}{" "}
          <a href={definitionHref("chain-roles")} className="underline underline-offset-4">
            How these are defined
          </a>
        </>
      ),
    },
  ];
  return (
    <section id="chain-roles-view" data-section="view-e" className="card-grid">
      <VelocityCard kpis={kpis} definitions={definitions} warnings={warnings} state={state} />
      <ChartCard
        id={CARD_ANCHORS.chainRoles}
        takeaway={chainRolesHeading(chain_roles)}
        detail={<p>{chainRolesTakeaway(chain_roles)}</p>}
        chip="inferred"
        source="Chain data and public labels"
        asOf={dayRange(chain_roles.map((row) => row.as_of_day)) ?? DAY_ZERO}
        definitionHref={definitionHref("chain-roles")}
        frameWord={state.frameWord}
        summary={chainRolesSummary(chain_roles)}
        plotIsContent
        notes={notes}
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
      >
        {rows.length === 0 ? (
          <p className="p-4">{UNKNOWN_TEXT}</p>
        ) : (
          <ChainGrid rows={chain_roles} pin={1} />
        )}
      </ChartCard>
    </section>
  );
}
