import type { DatasetState, KpiRow as KpiRowData } from "@/lib/dataset";
import { allChainKpis } from "@/lib/aggregate";
import {
  CHAIN_NAMES,
  definitionHref,
  REQUIRED_CHAINS,
  type DefinitionAnchor,
} from "@/lib/definitions";
import { formatAsOf, formatBps, formatCompact, UNKNOWN_TEXT } from "@/lib/format";
import { InfoTip } from "./tooltip";

export type KpiRowProps = {
  kpis: KpiRowData[];
  state: DatasetState;
};

type Kpi = { label: string; value: string; note: string; anchor: DefinitionAnchor };

// Wallet counts stay out: they can't be summed across chains, because one address on three EVM
// chains would count three times. Everyday velocity answers the question; clean velocity is mostly
// large transfers, so view B shows all three together.
function kpiList(figures: ReturnType<typeof allChainKpis>): Kpi[] {
  return [
    {
      label: "Total supply",
      value: figures ? formatCompact(figures.total_supply) : UNKNOWN_TEXT,
      note: "Minted minus burned, at the close of each chain's latest day.",
      anchor: "minted-burned",
    },
    {
      label: "Placed share",
      value: figures ? formatBps(figures.placed_share_bps) : UNKNOWN_TEXT,
      note: "Share of supply that has stayed in large wallets with no issuer, venue or system label, for the placed window.",
      anchor: "placed-supply",
    },
    {
      label: "7-day everyday volume",
      value: figures ? formatCompact(figures.clean_everyday_7d) : UNKNOWN_TEXT,
      note: "Clean transfers below the large-transfer size, over the last 7 days.",
      anchor: "everyday-large",
    },
    {
      label: "Everyday velocity",
      value: figures ? formatBps(figures.velocity_everyday_bps) : UNKNOWN_TEXT,
      note: "Everyday volume a day as a share of circulating supply, over 7 days.",
      anchor: "velocity",
    },
  ];
}

// The as-of line above the row covers these figures, and the row covers every chain, so a line under
// it says only what differs: the chains, if one is missing, and the date, if it isn't the page's.
function scopeLine(
  figures: NonNullable<ReturnType<typeof allChainKpis>>,
  state: DatasetState,
): string | null {
  const parts: string[] = [];
  if (REQUIRED_CHAINS.some((chain) => !figures.chains.includes(chain))) {
    parts.push(`Across ${figures.chains.map((chain) => CHAIN_NAMES[chain]).join(", ")}.`);
  }
  const asOf = formatAsOf(figures.asOf);
  if (!state.dataAsOf || formatAsOf(state.dataAsOf) !== asOf) parts.push(`As of ${asOf}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function KpiRow({ kpis, state }: KpiRowProps) {
  const figures = allChainKpis(kpis);
  const line = figures ? scopeLine(figures, state) : UNKNOWN_TEXT;
  return (
    <section className="kpi-row" aria-label="Key figures" data-section="kpi-row">
      <dl className="kpi-row__cells">
        {kpiList(figures).map((kpi) => (
          <div key={kpi.label} className="kpi-cell explain-head">
            <dt>{kpi.label}</dt>
            <dd className="kpi-cell__figure">
              <span data-kpi-value>{kpi.value}</span>
            </dd>
            <dd className="kpi-cell__more">
              <InfoTip label={`About: ${kpi.label}`}>
                <p data-kpi-note>{kpi.note}</p>
                {figures ? <p>As of {formatAsOf(figures.asOf)}</p> : null}
                <p>
                  <a
                    href={definitionHref(kpi.anchor)}
                    className="target-link underline underline-offset-4"
                  >
                    Definition
                  </a>
                </p>
              </InfoTip>
              <noscript>
                <p className="kpi-cell__note">
                  {kpi.note}{" "}
                  <a href={definitionHref(kpi.anchor)} className="underline underline-offset-4">
                    Definition
                  </a>
                </p>
              </noscript>
            </dd>
          </div>
        ))}
      </dl>
      {line || state.frameWord ? (
        <p className="chart-card__meta mt-2" data-kpi-scope>
          {line}
          {line && state.frameWord ? " · " : null}
          {state.frameWord ? <strong data-frame-word>{state.frameWord}</strong> : null}
        </p>
      ) : null}
    </section>
  );
}
