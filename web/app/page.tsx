import { KpiRow } from "@/components/kpi-row";
import { TrustStrip } from "@/components/trust-strip";
import { VerdictBlock } from "@/components/verdict-block";
import { ActivityView } from "@/components/views/activity";
import { ChainRolesView } from "@/components/views/chain-roles";
import { JourneyView } from "@/components/views/journey";
import { getDataset } from "@/lib/dataset";

export default function Home() {
  const dataset = getDataset();
  const { manifest, summary, state } = dataset;
  const { verdict, kpis } = summary;
  return (
    <main id="main-content" className="page-main">
      <div className="first-screen">
        <VerdictBlock verdict={verdict} kpis={kpis} state={state} />
        <KpiRow kpis={kpis} state={state} />
        <TrustStrip
          reconciliation={dataset.reconciliation}
          latest_run={dataset.latest_run}
          checks={manifest.checks}
          coverage={manifest.coverage}
          state={state}
        />
      </div>
      <JourneyView
        journey={dataset.journey}
        activity={dataset.activity}
        kpis={kpis}
        definitions={manifest.definitions}
        state={state}
      />
      <ActivityView
        activity={dataset.activity}
        kpis={kpis}
        definitions={manifest.definitions}
        warnings={manifest.warnings}
        state={state}
      />
      <ChainRolesView chain_roles={dataset.chain_roles} state={state} />
    </main>
  );
}
