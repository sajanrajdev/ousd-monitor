import { ChainFilter } from "@/components/chain-filter";
import { FindingsRow } from "@/components/findings-row";
import { KpiRow } from "@/components/kpi-row";
import { MarkerLegend } from "@/components/marker-legend";
import { TrustStrip } from "@/components/trust-strip";
import { VerdictBlock } from "@/components/verdict-block";
import { ActivityView } from "@/components/views/activity";
import { ChainRolesView } from "@/components/views/chain-roles";
import { JourneyView } from "@/components/views/journey";
import { chainOptions } from "@/lib/chain-scope";
import { getDataset } from "@/lib/dataset";
import { exchangeRows } from "@/lib/exchange-rows";

export default function Home() {
  const dataset = getDataset();
  const { manifest, summary, state } = dataset;
  const { verdict, kpis } = summary;
  const options = chainOptions(manifest.coverage.chains_included);
  return (
    <main id="main-content" className="page-main">
      <div className="first-screen">
        <TrustStrip
          reconciliation={dataset.reconciliation}
          latest_run={dataset.latest_run}
          checks={manifest.checks}
          coverage={manifest.coverage}
          state={state}
        />
        <VerdictBlock verdict={verdict} kpis={kpis} state={state} />
        <KpiRow kpis={kpis} state={state} />
        <FindingsRow
          journey={dataset.journey}
          activity={dataset.activity}
          chain_roles={dataset.chain_roles}
          definitions={manifest.definitions}
          state={state}
        />
        <MarkerLegend />
      </div>
      <div className="dashboard">
        <ChainFilter options={options} />
        <JourneyView
          options={options}
          journey={dataset.journey}
          activity={dataset.activity}
          kpis={kpis}
          definitions={manifest.definitions}
          state={state}
          exchanges={exchangeRows(dataset.labels)}
        />
        <ActivityView
          options={options}
          activity={dataset.activity}
          kpis={kpis}
          definitions={manifest.definitions}
          warnings={manifest.warnings}
          state={state}
        />
        <ChainRolesView chain_roles={dataset.chain_roles} state={state} />
      </div>
    </main>
  );
}
