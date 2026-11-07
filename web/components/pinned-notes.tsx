import { Fragment, type ReactNode } from "react";
import type { ChainName } from "@/lib/dataset/rows";

export type PinnedNote = {
  // What the note is, on `data-note`, so a check can find a caveat wherever it is pinned.
  kind: string;
  // Names its chain or part in words, so it reads without the chart.
  text: ReactNode;
  chain?: ChainName;
  // The caveat explained in full, after its words in the footnote. `interactive` when it, or the
  // text, holds a link.
  tip?: ReactNode;
  interactive?: boolean;
  // What the note qualifies: a legend row's segment, a waterfall row's step or a chain, where the
  // card puts its marker. With none, it's about the whole card and its marker is on the title.
  at?: string;
};

// Notes about the whole card come first, as their markers are on the title, then the rest in their
// own order, which is the order the card draws what they qualify: reading order.
export function orderedNotes(notes: PinnedNote[]): PinnedNote[] {
  return [...notes.filter((note) => !note.at), ...notes.filter((note) => note.at)];
}

// A note's number is its place in that order, so it's worked out and never written by hand. Null if
// a conditional note dropped out.
export function pinNumber(
  notes: PinnedNote[],
  kind: PinnedNote["kind"],
  chain?: ChainName,
): number | null {
  const index = orderedNotes(notes).findIndex((note) => note.kind === kind && note.chain === chain);
  return index === -1 ? null : index + 1;
}

// A footnote's id, from its card's prefix and its number.
export function footnoteId(prefix: string, number: number): string {
  return `${prefix}-fn-${number}`;
}

// Quiet superscript references, in the body text's own style, for what sits at `at`, or for the
// whole card with no `at`, at the end of the row, label or title they qualify. Each links to its
// footnote, which opens the card's list. No tooltip: the words are in the list. The maintainer's
// call after the page reviews, over the earlier rule that a caveat's words stay in view.
export function NoteMarks({
  notes,
  at,
  prefix,
}: {
  notes: PinnedNote[];
  at?: string;
  prefix: string;
}) {
  const here = orderedNotes(notes).flatMap((note, index) =>
    note.at === at ? [{ note, number: index + 1 }] : [],
  );
  if (here.length === 0) return null;
  return (
    <sup className="fn-refs" data-fn-refs data-at={at}>
      {here.map(({ note, number }, index) => (
        <Fragment key={`${note.kind}:${note.chain ?? ""}`}>
          {index > 0 ? "," : null}
          <a
            href={`#${footnoteId(prefix, number)}`}
            className="fn-ref"
            aria-label={`Footnote ${number}`}
            data-fn-ref={number}
            data-note={note.kind}
            data-chain={note.chain}
          >
            {number}
          </a>
        </Fragment>
      ))}
    </sup>
  );
}

// The card's footnotes, closed by default under a "Footnotes" toggle on its last row, and opened
// below its content as a numbered list whose numbers match the markers. A details element, so it
// opens by keyboard and with JavaScript off. Never in a noscript or a tooltip, which verify-output
// fails.
export function Footnotes({ notes, prefix }: { notes: PinnedNote[]; prefix: string }) {
  if (notes.length === 0) return null;
  return (
    <details className="footnotes" data-footnotes>
      <summary>Footnotes</summary>
      <ol className="footnotes__list" aria-label="Footnotes">
        {orderedNotes(notes).map((note, index) => (
          <li
            key={`${note.kind}:${note.chain ?? ""}`}
            id={footnoteId(prefix, index + 1)}
            // So a marker can move focus here without the page jumping to it.
            tabIndex={-1}
            data-note={note.kind}
            data-chain={note.chain}
          >
            <span data-note-text>{note.text}</span>
            {note.tip ? (
              <>
                {" "}
                <span data-note-full>{note.tip}</span>
              </>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
