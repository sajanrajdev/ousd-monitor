import { useId, type ReactNode } from "react";
import type { FrameWord } from "@/lib/dataset/state";
import { formatAsOf, type AsOfRange } from "@/lib/format";
import { DataToggle } from "./data-toggle";
import { HairlineTable, type HairlineTableProps } from "./hairline-table";
import { InfoPopover } from "./info-popover";
import { PinnedNotes, type PinnedNote } from "./pinned-notes";
import { StatusChip, type ChipKind } from "./status-chip";

// Every prop from `takeaway` to `children` is required, so a chart missing its source, time,
// definition, summary or table doesn't compile. `frameWord` comes from the dataset's state and is
// required too, so a card on sample or preview data can't forget to say so, even cropped alone. The
// summary and table are server-rendered; Recharts is not.
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
  // The card's anchor. Under a filter it goes on ChainPanels instead, as a panel repeats its card.
  id?: string;
  // Short caveats, always visible, numbered to their pins in the chart.
  notes?: PinnedNote[];
  // More for the popover, under the summary: the long takeaway or a note in full. Nothing essential.
  detail?: ReactNode;
  // Further tables under the data toggle, after the chart's own.
  moreTables?: ReactNode;
  // For a chart that only draws in the browser. A hand-built chart is in the static HTML.
  needsJs?: boolean;
  // For a plot that is itself real content, such as a table with words for assistive tech. Otherwise
  // the graphic is hidden from assistive tech, as the summary and table carry what it shows.
  plotIsContent?: boolean;
  // Words a reader needs beside the chart or table, such as a caveat with a link. Read by everyone:
  // the graphic is hidden from assistive tech, and the summary is a plain string.
  note?: ReactNode;
  level?: 2 | 3;
};

// A card whose content is its table: no chart, and no second table behind a toggle.
export type TableCardProps = Omit<
  ChartCardProps,
  "children" | "moreTables" | "needsJs" | "plotIsContent"
>;

type CardFrameProps = Pick<
  ChartCardProps,
  | "takeaway"
  | "chip"
  | "source"
  | "asOf"
  | "definitionHref"
  | "frameWord"
  | "summary"
  | "id"
  | "detail"
  | "level"
> & { children: ReactNode };

function cardAsOf(asOf: string | AsOfRange): { dateTime: string; text: string } {
  const dateTime = typeof asOf === "string" ? asOf : asOf.to;
  return { dateTime, text: formatAsOf(asOf) };
}

function CardNote({ note }: { note: ReactNode }) {
  return note ? <div className="chart-card__note mt-3">{note}</div> : null;
}

// The parts every card has. The as-of time and frame word stay visible, so a cropped card still says
// them. Source and definition sit in the popover, and in a plain note with JavaScript off.
function CardFrame({
  takeaway,
  chip,
  source,
  asOf,
  definitionHref,
  frameWord,
  summary,
  id,
  detail,
  level = 2,
  children,
}: CardFrameProps) {
  const headingId = useId();
  const Heading = level === 3 ? "h3" : "h2";
  const when = cardAsOf(asOf);
  return (
    <section
      id={id}
      className="chart-card"
      aria-labelledby={headingId}
      data-frame={frameWord ?? undefined}
    >
      <div className="chart-card__head explain-head">
        <Heading id={headingId}>{takeaway}</Heading>
        <StatusChip kind={chip} frameWord={frameWord} />
        <InfoPopover label={`About: ${takeaway}`}>
          <p>{summary}</p>
          {detail}
          <p>Source: {source}</p>
          <p>As of {when.text}</p>
          <p>
            <a href={definitionHref} className="target-link underline underline-offset-4">
              Definition
            </a>
          </p>
        </InfoPopover>
      </div>
      <p className="sr-only">{summary}</p>
      {children}
      <p className="chart-card__meta mt-3">
        As of <time dateTime={when.dateTime}>{when.text}</time>
        {frameWord ? (
          <>
            {" "}
            · <strong className="chart-card__frame-word">{frameWord}</strong>
          </>
        ) : null}
      </p>
      <noscript>
        <p className="chart-card__source-note">
          Source: {source} ·{" "}
          <a href={definitionHref} className="target-link underline underline-offset-4">
            Definition
          </a>
        </p>
      </noscript>
    </section>
  );
}

export function ChartCard({
  table,
  children,
  notes = [],
  moreTables,
  needsJs = false,
  plotIsContent = false,
  note,
  ...frame
}: ChartCardProps) {
  return (
    <CardFrame {...frame}>
      <div className="chart-card__body" data-notes={notes.length > 0 || undefined}>
        <div className="chart-card__plot">
          {/* aria-hidden and nothing focusable inside; not inert, so hover tooltips still work. */}
          <div
            className="chart-area"
            aria-hidden={plotIsContent ? undefined : "true"}
            data-plot-content={plotIsContent || undefined}
          >
            {children}
          </div>
          {needsJs ? (
            <noscript>
              <p className="chart-area__needs-js">
                This chart needs JavaScript. The Table button has the same data.
              </p>
            </noscript>
          ) : null}
        </div>
        <PinnedNotes notes={notes} />
      </div>
      <CardNote note={note} />
      <DataToggle label={frame.takeaway}>
        <HairlineTable {...table} />
        {moreTables}
      </DataToggle>
    </CardFrame>
  );
}

export function TableCard({ table, notes = [], note, ...frame }: TableCardProps) {
  return (
    <CardFrame {...frame}>
      <div className="mt-4">
        <HairlineTable {...table} />
      </div>
      {notes.length > 0 ? (
        <div className="mt-3">
          <PinnedNotes notes={notes} />
        </div>
      ) : null}
      <CardNote note={note} />
    </CardFrame>
  );
}
