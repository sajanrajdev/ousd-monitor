import type { DatasetState, KpiRow as KpiRowData } from "@/lib/dataset";
import { allChainKpis } from "@/lib/aggregate";
import { CHAIN_NAMES, definitionHref, type DefinitionAnchor } from "@/lib/definitions";
import { formatAsOf, formatBps, formatCompact, UNKNOWN_TEXT } from "@/lib/format";
import { StatusChip, type ChipKind } from "./status-chip";

export type KpiRowProps = {
  kpis: KpiRowData[];
  state: DatasetState;
};

type Kpi = { label: string; value: string; note: string; chip: ChipKind; anchor: DefinitionAnchor };

// Wallet counts stay out: they can't be summed across chains, because one address on three EVM
// chains would count three times. Everyday velocity answers the question; clean velocity is mostly
// large transfers, so view B shows all three together.
function kpiList(figures: ReturnType<typeof allChainKpis>): Kpi[] {
  return [
    {
      label: "Total supply",
      value: figures ? formatCompact(figures.total_supply) : UNKNOWN_TEXT,
      note: "Minted minus burned, at the close of each chain's latest day.",
      chip: "fact",
      anchor: "minted-burned",
    },
    {
      label: "Placed share",
      value: figures ? formatBps(figures.placed_share_bps) : UNKNOWN_TEXT,
      note: "Share of supply that has stayed in large unlabeled wallets for the placed window.",
      chip: "inferred",
      anchor: "placed-supply",
    },
    {
      label: "7-day everyday volume",
      value: figures ? formatCompact(figures.clean_everyday_7d) : UNKNOWN_TEXT,
      note: "Clean transfers below the large-transfer size, over the last 7 days.",
      chip: "inferred",
      anchor: "everyday-large",
    },
    {
      label: "Everyday velocity",
      value: figures ? formatBps(figures.velocity_everyday_bps) : UNKNOWN_TEXT,
      note: "Everyday volume a day as a share of circulating supply, over 7 days.",
      chip: "inferred",
      anchor: "velocity",
    },
  ];
}

export function KpiRow({ kpis, state }: KpiRowProps) {
  const figures = allChainKpis(kpis);
  return (
    <section className="kpi-row" aria-label="Key figures" data-section="kpi-row">
      <dl className="m-0 grid grid-cols-2 gap-px border border-(--color-border) bg-(--color-border) min-[1056px]:grid-cols-4">
        {kpiList(figures).map((kpi) => (
          <div key={kpi.label} className="grid content-start gap-2 bg-(--color-off-white) p-4">
            <dt className="text-(length:--text-small)">{kpi.label}</dt>
            <dd className="m-0 grid gap-2">
              <span
                className="font-(family-name:--font-display) text-(length:--text-kpi) leading-none"
                data-kpi-value
              >
                {kpi.value}
              </span>
              <span>
                <StatusChip kind={kpi.chip} />
              </span>
              <span className="text-(length:--text-meta)">
                {kpi.note}{" "}
                <a href={definitionHref(kpi.anchor)} className="underline underline-offset-4">
                  Definition
                </a>
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="chart-card__meta mt-2">
        {figures
          ? `Across ${figures.chains.map((chain) => CHAIN_NAMES[chain]).join(", ")}. As of ${formatAsOf(figures.asOf)}`
          : UNKNOWN_TEXT}
        {state.frameWord ? (
          <>
            {" "}
            · <strong data-frame-word>{state.frameWord}</strong>
          </>
        ) : null}
      </p>
    </section>
  );
}
