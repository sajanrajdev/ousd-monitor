import type { Metadata } from "next";
import Link from "next/link";
import { ReconciliationDetail } from "@/components/trust-strip";
import { getDataset } from "@/lib/dataset";

export const metadata: Metadata = { title: "Reconciliation" };

// What the trust row's disclosure held, on its own page, so the main page keeps one word for it.
export default function Reconciliation() {
  const dataset = getDataset();
  return (
    <main id="main-content" className="page-main">
      <div className="reconciliation-page">
        <p>
          <Link href="/" className="target-link underline underline-offset-4" data-back-link>
            Back to the dashboard
          </Link>
        </p>
        <h1 style={{ fontSize: "var(--text-h2)" }}>Reconciliation</h1>
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
