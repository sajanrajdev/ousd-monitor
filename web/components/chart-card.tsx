import { useId, type ReactNode } from "react";
import { Accordion } from "./accordion";
import type { FrameWord } from "@/lib/dataset/state";
import { formatAsOf, type AsOfRange } from "@/lib/format";
import { HairlineTable, type HairlineTableProps } from "./hairline-table";
import { StatusChip, type ChipKind } from "./status-chip";

// Every prop but `level` is required, so a chart missing its source, time, definition, summary or
// table doesn't compile. `frameWord` comes from the dataset's state and is required too, so a card
// on sample or preview data can't forget to say so, even cropped alone. The summary and table are
// server-rendered; Recharts is not.
export type ChartCardProps = {
  takeaway: string;
  chip: ChipKind;
  source: string;
  asOf: string | AsOfRange;
  definitionHref: string;
  frameWord: FrameWord | null;
  summary: string;
  table: HairlineTableProps;
  children: ReactNode;
  level?: 2 | 3;
};

// A card whose content is its table: no chart, and no second table in an accordion.
export type TableCardProps = Omit<ChartCardProps, "children">;

function cardAsOf(asOf: string | AsOfRange): { dateTime: string; text: string } {
  const dateTime = typeof asOf === "string" ? asOf : asOf.to;
  return { dateTime, text: formatAsOf(asOf) };
}

function CardHead({
  headingId,
  takeaway,
  chip,
  frameWord,
  level,
}: Pick<ChartCardProps, "takeaway" | "chip" | "frameWord" | "level"> & { headingId: string }) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <div className="flex items-start justify-between gap-3">
      <Heading id={headingId} style={{ fontSize: "var(--text-h2)" }}>
        {takeaway}
      </Heading>
      <StatusChip kind={chip} frameWord={frameWord} />
    </div>
  );
}

function CardMeta({
  source,
  asOf,
  definitionHref,
  frameWord,
}: Pick<ChartCardProps, "source" | "asOf" | "definitionHref" | "frameWord">) {
  const when = cardAsOf(asOf);
  return (
    <p className="chart-card__meta mt-3">
      Source: {source} · As of <time dateTime={when.dateTime}>{when.text}</time>
      {frameWord ? (
        <>
          {" "}
          · <strong className="chart-card__frame-word">{frameWord}</strong>
        </>
      ) : null}{" "}
      ·{" "}
      <a href={definitionHref} className="underline underline-offset-4">
        Definition
      </a>
    </p>
  );
}

export function ChartCard({
  takeaway,
  chip,
  source,
  asOf,
  definitionHref,
  frameWord,
  summary,
  table,
  children,
  level = 2,
}: ChartCardProps) {
  const headingId = useId();
  return (
    <section className="chart-card" aria-labelledby={headingId} data-frame={frameWord ?? undefined}>
      <CardHead
        headingId={headingId}
        takeaway={takeaway}
        chip={chip}
        frameWord={frameWord}
        level={level}
      />
      <p className="mt-3">{summary}</p>
      {/* aria-hidden and nothing focusable inside; not inert, so hover tooltips still work. */}
      <div className="chart-area mt-4" aria-hidden="true">
        {children}
      </div>
      <noscript>
        <p className="chart-area__needs-js">
          This chart needs JavaScript. The table below has the same data.
        </p>
      </noscript>
      <div className="mt-4">
        <Accordion title="Table of the same data">
          <HairlineTable {...table} />
        </Accordion>
      </div>
      <CardMeta source={source} asOf={asOf} definitionHref={definitionHref} frameWord={frameWord} />
    </section>
  );
}

export function TableCard({
  takeaway,
  chip,
  source,
  asOf,
  definitionHref,
  frameWord,
  summary,
  table,
  level = 2,
}: TableCardProps) {
  const headingId = useId();
  return (
    <section className="chart-card" aria-labelledby={headingId} data-frame={frameWord ?? undefined}>
      <CardHead
        headingId={headingId}
        takeaway={takeaway}
        chip={chip}
        frameWord={frameWord}
        level={level}
      />
      <p className="mt-3">{summary}</p>
      <div className="mt-4">
        <HairlineTable {...table} />
      </div>
      <CardMeta source={source} asOf={asOf} definitionHref={definitionHref} frameWord={frameWord} />
    </section>
  );
}
