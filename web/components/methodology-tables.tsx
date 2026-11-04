import { Fragment, type ReactNode } from "react";
import { TableCard } from "./chart-card";
import { HairlineTable } from "./hairline-table";
import type { Dataset, DatasetState, KnownLimit, Manifest } from "@/lib/dataset";
import { formatExact, formatUtcDate, UNKNOWN_TEXT } from "@/lib/format";
import {
  CATEGORY_NAMES,
  clusterTotals,
  DATASET_LIMIT_MEASURED,
  EXTRA_LIMITS,
  labelsTakeaway,
  latestCheck,
  namedLabels,
  settingRows,
  settingsTakeaway,
} from "@/lib/methodology";

// The dataset's words carry `code` spans in markdown. Show them as code, and nothing else.
type LabelsFile = Dataset["labels"];

export function Ticks({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="font-mono text-[0.9em] [overflow-wrap:anywhere]">
            {part}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Outbound({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} rel="noopener noreferrer" className="target-link underline underline-offset-4">
      {children}
    </a>
  );
}

// The legend is the dataset's own, which the pipeline reads from labels/README.md.
export function SourceLegend({ legend }: { legend: LabelsFile["source_legend"] }) {
  return (
    <div data-source-legend className="mt-3">
      <HairlineTable
        caption="How we know: the source legend"
        columns={[
          { key: "type", label: "Source type" },
          { key: "meaning", label: "What it means" },
          { key: "check", label: "How to check it" },
        ]}
        rows={legend.source_types.map((row) => ({
          type: <code className="font-mono text-[0.9em]">{row.source_type}</code>,
          meaning: <Ticks text={row.meaning} />,
          check: <Ticks text={row.how_to_check} />,
        }))}
      />
      <p className="mt-3">
        <strong>Reading a label:</strong> <Ticks text={legend.reading_a_label} />
      </p>
    </div>
  );
}

// Every named label, with its source type, source and date. A bad source stops the build.
export function NamedLabelsCard({
  labels,
  state,
  fallbackAsOf,
}: {
  labels: LabelsFile["data"];
  state: DatasetState;
  fallbackAsOf: string;
}) {
  const rows = namedLabels(labels);
  return (
    <div data-labels-table className="mt-4">
      <TableCard
        level={3}
        takeaway={labelsTakeaway(rows)}
        chip="inferred"
        source="Public sources, linked in each row"
        asOf={latestCheck(rows) ?? fallbackAsOf}
        definitionHref="/methodology/#named-labels"
        frameWord={state.frameWord}
        summary="A name is shown only because the linked source ties it to the address. The site shows no address: the source does."
        note={
          <p>
            Source types are explained in{" "}
            <a href="#source-legend" className="underline underline-offset-4">
              the legend
            </a>
            . Confidence is medium when the source leaves a gap.
          </p>
        }
        table={{
          caption: "Named labels, by entity",
          columns: [
            { key: "entity", label: "Entity" },
            { key: "chain", label: "Chain" },
            { key: "category", label: "Category" },
            { key: "type", label: "Source type" },
            { key: "source", label: "Source" },
            { key: "confidence", label: "Confidence" },
            { key: "checked", label: "Checked" },
          ],
          rows: rows.map((label) => ({
            entity: label.entity,
            chain: CHAIN_LABEL[label.chain],
            category: CATEGORY_NAMES[label.category],
            type: <code className="font-mono text-[0.9em]">{label.sourceType}</code>,
            source: <Outbound href={label.sourceUrl}>{label.sourceHost}</Outbound>,
            confidence: label.confidence,
            checked: formatUtcDate(label.dateChecked),
          })),
        }}
      />
    </div>
  );
}

const CHAIN_LABEL = {
  tempo: "Tempo",
  ethereum: "Ethereum",
  base: "Base",
  solana: "Solana",
} as const;

// Counts by category and the written rule, and never an address.
export function UnnamedClusters({ clusters }: { clusters: LabelsFile["unnamed_clusters"] }) {
  const totals = clusterTotals(clusters.counts);
  return (
    <div data-unnamed-clusters className="mt-3">
      {totals.length === 0 ? (
        <p>{UNKNOWN_TEXT}</p>
      ) : (
        <HairlineTable
          caption="Unnamed clusters by category. Wallets, not people."
          columns={[
            { key: "category", label: "Category" },
            { key: "total", label: "Wallets", numeric: true },
            { key: "chains", label: "By chain" },
          ]}
          rows={totals.map((row) => ({
            category: CATEGORY_NAMES[row.category],
            total: row.total,
            chains: row.byChain,
          }))}
        />
      )}
      <div data-unnamed-rule>
        {clusters.rule
          .split(/(?<=\.) (?=The redemption route|Published data)/)
          .map((part, index) => (
            <p key={index} className="mt-3">
              <Ticks text={part} />
            </p>
          ))}
      </div>
    </div>
  );
}

export function datasetLimitText(limit: KnownLimit): string {
  const measured = DATASET_LIMIT_MEASURED[limit.id];
  return measured ? `${limit.text} (measured ${measured})` : limit.text;
}

export function DatasetLimits({ limits }: { limits: readonly KnownLimit[] }) {
  return (
    <ul className="mt-3 list-disc pl-6" data-dataset-limits>
      {limits.map((limit) => (
        <li key={limit.id} className="mt-1">
          {datasetLimitText(limit)}
        </li>
      ))}
    </ul>
  );
}

export function ExtraLimits() {
  return (
    <div data-extra-limits className="mt-3">
      <HairlineTable
        caption="Limits not in the dataset"
        columns={[
          { key: "limit", label: "Limit" },
          { key: "measured", label: "Measured" },
          { key: "from", label: "From" },
        ]}
        rows={EXTRA_LIMITS.map((limit) => ({
          limit: limit.text,
          measured: limit.measured ?? "",
          from: limit.from,
        }))}
      />
    </div>
  );
}

function shown(name: string, value: string): ReactNode {
  return name.endsWith("_base_units") ? (
    <>
      <code className="font-mono text-[0.9em]">{value}</code> ({formatExact(value)})
    </>
  ) : (
    <code className="font-mono text-[0.9em]">{value}</code>
  );
}

export function SettingsCard({ manifest, state }: { manifest: Manifest; state: DatasetState }) {
  const rows = settingRows(manifest.definitions);
  return (
    <div className="mt-4">
      <TableCard
        level={3}
        takeaway={settingsTakeaway(rows)}
        chip="fact"
        source="This dataset's manifest"
        asOf={manifest.generated_at}
        definitionHref="/methodology/#documented-defaults"
        frameWord={state.frameWord}
        summary="The values the pipeline was built with, beside the documented defaults. Amounts are in base units, 6 to the dollar."
        note={<p>Amounts are in base units, 6 to the dollar.</p>}
        table={{
          caption: "Settings in this dataset",
          columns: [
            { key: "name", label: "Setting" },
            { key: "value", label: "In this dataset" },
            { key: "documented", label: "Documented default" },
          ],
          rows: rows.map((row) => ({
            name: <code className="font-mono text-[0.9em]">{row.name}</code>,
            value: shown(row.name, row.value),
            documented: row.same ? "Same" : shown(row.name, row.documented),
          })),
        }}
      />
    </div>
  );
}
