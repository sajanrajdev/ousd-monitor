import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  DatasetLimits,
  ExtraLimits,
  NamedLabelsCard,
  SettingsCard,
  SourceLegend,
  UnnamedClusters,
} from "@/components/methodology-tables";
import { ExchangeHoldingsCard, ExchangeListingsCard } from "@/components/exchange-holdings";
import { getDataset, type Dataset } from "@/lib/dataset";
import {
  loadMethodology,
  MIRRORED_SECTIONS,
  sectionList,
  type Chunk,
  type MirroredSection,
} from "@/lib/methodology";

export const metadata: Metadata = { title: "Methodology" };

// What the page shows in place of a mirrored section's body, which the doc keeps for GitHub readers.
function mirrored(id: MirroredSection, dataset: Dataset): ReactNode {
  switch (id) {
    case "source-legend":
      return <SourceLegend legend={dataset.labels.source_legend} />;
    case "limits-in-the-dataset":
      return <DatasetLimits limits={dataset.summary.known_limits} />;
    case "limits-not-in-the-dataset":
      return <ExtraLimits />;
    case "the-rule":
      return <UnnamedClusters clusters={dataset.labels.unnamed_clusters} />;
    case "documented-defaults":
      return <SettingsCard manifest={dataset.manifest} state={dataset.state} />;
  }
}

function isMirrored(id: string): id is MirroredSection {
  return (MIRRORED_SECTIONS as readonly string[]).includes(id);
}

// One list, the top-level sections in order. A section's own items sit indented under it, in compact
// columns of their own, so a long one leaves no gap beside the rest.
function Contents({ items }: { items: ReturnType<typeof sectionList> }) {
  const list = (
    <ol className="mt-3 grid gap-1 text-sm" data-contents-list>
      {items.map((item) => (
        <li key={item.id}>
          <a href={`#${item.id}`} className="target-link underline underline-offset-4">
            {item.title}
          </a>
          {item.children.length > 0 ? (
            <ul className="mb-1 ml-4 mt-1 max-w-3xl gap-x-6 text-[length:var(--text-meta)] sm:columns-2 lg:columns-3">
              {item.children.map((child) => (
                <li key={child.id} className="mb-1 break-inside-avoid">
                  <a href={`#${child.id}`} className="target-link underline underline-offset-4">
                    {child.title}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
  return (
    <nav aria-label="On this page" data-section="contents">
      <details className="accordion md:hidden">
        <summary>On this page</summary>
        <div className="pb-4">{list}</div>
      </details>
      <div className="hidden md:block">
        <p className="font-semibold">On this page</p>
        {list}
      </div>
    </nav>
  );
}

export default function Methodology() {
  const dataset = getDataset();
  const chunks: Chunk[] = loadMethodology();
  return (
    <main id="main-content" className="page-main">
      <div className="max-w-5xl">
        <p className="mb-4">
          <Link href="/" className="target-link underline underline-offset-4" data-back-link>
            Back to the dashboard
          </Link>
        </p>
        <h1 style={{ fontSize: "var(--text-display)" }}>Methodology</h1>
        <div className="mt-6">
          <Contents items={sectionList(chunks)} />
        </div>
      </div>
      <article className="grid max-w-5xl gap-2" data-section="methodology">
        {chunks.map((chunk) => (
          <div key={chunk.id} className={chunk.level === 2 ? "mt-10" : undefined}>
            <div className="max-w-3xl" dangerouslySetInnerHTML={{ __html: chunk.headingHtml }} />
            {isMirrored(chunk.id) ? (
              mirrored(chunk.id, dataset)
            ) : (
              <div className="max-w-3xl" dangerouslySetInnerHTML={{ __html: chunk.bodyHtml }} />
            )}
            {chunk.id === "named-labels" ? (
              <NamedLabelsCard
                labels={dataset.labels.data}
                state={dataset.state}
                fallbackAsOf={dataset.manifest.generated_at}
              />
            ) : null}
            {chunk.id === "named-labels" ? (
              <ExchangeHoldingsCard
                holdings={dataset.labels.exchange_holdings}
                state={dataset.state}
                fallbackAsOf={dataset.manifest.generated_at}
              />
            ) : null}
            {chunk.id === "named-labels" ? (
              <ExchangeListingsCard
                listings={dataset.labels.exchange_listings}
                state={dataset.state}
                fallbackAsOf={dataset.manifest.generated_at}
              />
            ) : null}
          </div>
        ))}
      </article>
    </main>
  );
}
