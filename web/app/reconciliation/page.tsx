import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { ReconciliationDetail } from "@/components/trust-strip";
import { getDataset } from "@/lib/dataset";

export const metadata: Metadata = { title: "Reconciliation" };

// The detail behind the footer's status, on its own page, so the main page keeps one word for it.
export default function Reconciliation() {
  const dataset = getDataset();
  return (
    <main id="main-content" className="page-main">
      <div className="reconciliation-page">
        <BackLink />
        <h1 className="page-title">Reconciliation</h1>
        <ReconciliationDetail
          reconciliation={dataset.reconciliation}
          latest_run={dataset.latest_run}
          checks={dataset.manifest.checks}
          state={dataset.state}
        />
      </div>
    </main>
  );
}
