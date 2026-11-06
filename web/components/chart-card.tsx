import { useId, type ReactNode } from "react";
import type { FrameWord } from "@/lib/dataset/state";
import { formatAsOf, type AsOfRange } from "@/lib/format";
import { DataToggle } from "./data-toggle";
import { HairlineTable, type HairlineTableProps } from "./hairline-table";
import { Footnotes, NoteMarks, type PinnedNote } from "./pinned-notes";
import { InfoTip } from "./tooltip";

// Every prop from `takeaway` to `children` is required, so a chart missing its source, time,
// definition, summary or table doesn't compile. `frameWord` comes from the dataset's state and is
// required too, so a card on sample or preview data can't forget to say so, even cropped alone. The
// summary and table are server-rendered; Recharts is not.
export type ChartCardProps = {
  takeaway: string;
  source: string;
  asOf: string | AsOfRange;
  definitionHref: string;
  frameWord: FrameWord | null;
  summary: string;
  table: HairlineTableProps;
  children: ReactNode;
  // The card's anchor. Under a filter it goes on ChainPanels instead, as a panel repeats its card.
  id?: string;
  // Caveats, as footnotes. A note about the whole card has its marker on the title; the view puts
  // each other one's at what it qualifies, with NoteMarks and `footnotes`, the prefix of their ids.
  notes?: PinnedNote[];
  footnotes?: string;
  // More for the tooltip, under the summary: the long takeaway or a note in full. Nothing essential.
  detail?: ReactNode;
  // Further tables under the data toggle, after the chart's own.
  moreTables?: ReactNode;
  // For a chart that only draws in the browser. A hand-built chart is in the static HTML.
  needsJs?: boolean;
  // For a plot that is itself real content, such as a table with words for assistive tech. Otherwise
  // the graphic is hidden from assistive tech, as the summary and table carry what it shows.
  plotIsContent?: boolean;
  // What goes beside the chart from the card's width that has room: its legend, and any figures. Read
  // by assistive tech, as it's outside the hidden graphic.
  beside?: ReactNode;
  level?: 2 | 3;
};

// A card whose content is its table: no chart, and no second table behind a toggle. Only the
// methodology page uses it. `note` holds words a reader needs beside the table, read by everyone.
export type TableCardProps = Omit<
  ChartCardProps,
  "children" | "moreTables" | "needsJs" | "plotIsContent" | "beside"
> & { note?: ReactNode };

type CardFrameProps = Pick<
  ChartCardProps,
  | "takeaway"
  | "source"
  | "asOf"
  | "definitionHref"
  | "frameWord"
  | "summary"
  | "id"
  | "detail"
  | "level"
> & { children: ReactNode; notes?: PinnedNote[]; footnotes?: string };

function cardAsOf(asOf: string | AsOfRange): { dateTime: string; text: string } {
  const dateTime = typeof asOf === "string" ? asOf : asOf.to;
  return { dateTime, text: formatAsOf(asOf) };
}

function CardNote({ note }: { note: ReactNode }) {
  return note ? <div className="chart-card__note mt-3">{note}</div> : null;
}

// The parts every card has. The as-of time and frame word stay visible, so a cropped card still says
// them. A clock says the time is an as-of time, and the words are there for assistive tech. Source and definition sit in the tooltip, and in a plain note with JavaScript off.
function CardFrame({
  takeaway,
  source,
  asOf,
  definitionHref,
  frameWord,
  summary,
  id,
  detail,
  level = 2,
  children,
  notes = [],
  footnotes,
}: CardFrameProps) {
  const headingId = useId();
  const ownPrefix = useId();
  const prefix = footnotes ?? ownPrefix;
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
        <NoteMarks notes={notes} prefix={prefix} />
        <InfoTip label={`About: ${takeaway}`}>
          <p>{summary}</p>
          {detail}
          <p>Source: {source}</p>
          <p>As of {when.text}</p>
          <p>
            <a href={definitionHref} className="target-link underline underline-offset-4">
              Definition
            </a>
          </p>
        </InfoTip>
      </div>
      <p className="sr-only">{summary}</p>
      {children}
      <p className="chart-card__meta mt-3">
        <svg
          className="chart-card__clock"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" />
          <path d="M6 3v3h2.5" fill="none" stroke="currentColor" />
        </svg>
        <span className="sr-only">As of </span>
        <time dateTime={when.dateTime}>{when.text}</time>
        {frameWord ? (
          <>
            {" "}
            · <strong className="chart-card__frame-word">{frameWord}</strong>
          </>
        ) : null}
      </p>
      <Footnotes notes={notes} prefix={prefix} />
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
  beside,
  ...frame
}: ChartCardProps) {
  return (
    <CardFrame {...frame} notes={notes}>
      <div className="chart-card__body">
        <div className="chart-card__plot" data-beside={beside ? "" : undefined}>
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
          {beside ? <div className="chart-card__beside">{beside}</div> : null}
        </div>
      </div>
      <DataToggle label={frame.takeaway}>
        <HairlineTable {...table} />
        {moreTables}
      </DataToggle>
    </CardFrame>
  );
}

export function TableCard({ table, notes = [], note, ...frame }: TableCardProps) {
  return (
    <CardFrame {...frame} notes={notes}>
      <div className="mt-4">
        <HairlineTable {...table} />
      </div>
      <CardNote note={note} />
    </CardFrame>
  );
}
