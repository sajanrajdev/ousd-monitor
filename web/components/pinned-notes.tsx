import type { ReactNode } from "react";
import type { ChainName } from "@/lib/dataset/rows";
import { TextTip } from "./tooltip";

export type PinnedNote = {
  // What the note is, on `data-note`, so a check can find a caveat wherever it is pinned.
  kind: string;
  // Names its chain or part in words, so it reads without the chart.
  text: ReactNode;
  chain?: ChainName;
  // The caveat explained in full, under its words in the badge's tooltip. `interactive` when it, or
  // the text, holds a link.
  tip?: ReactNode;
  interactive?: boolean;
  // What the note qualifies: a legend row's segment, a waterfall row's step or a chain, where the
  // card puts its badge. With none, it's about the whole card and its badge sits by the title.
  at?: string;
};

// Notes about the whole card come first, as their badges sit by the title, then the rest in their
// own order, which is the order the card draws what they qualify.
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

// The numbered badges for what sits at `at`, or for the whole card with no `at`, inline at the end of
// the row, label or title they qualify. Each opens its note in the shared tooltip, on hover, focus or
// tap: the short caveat first, then the note in full. A card's badges are its only markers. This is
// the maintainer's call after the page reviews, over the earlier rule that a caveat's words stay in
// view. Never in a details or a noscript, which verify-output fails.
//
// `inTable` is the card's title copy of the badges that sit on its chart or legend, shown only while
// its table is, so a caveat stays in view when the chart it qualifies is swapped out.
export function NoteBadges({
  notes,
  at,
  inTable = false,
}: {
  notes: PinnedNote[];
  at?: string;
  inTable?: boolean;
}) {
  const here = orderedNotes(notes).flatMap((note, index) =>
    (inTable ? note.at !== undefined : note.at === at) ? [{ note, number: index + 1 }] : [],
  );
  if (here.length === 0) return null;
  return (
    <span
      className={inTable ? "note-badges note-badges--table" : "note-badges"}
      data-note-badges
      data-at={at}
      data-note-copy={inTable ? "" : undefined}
    >
      {here.map(({ note, number }) => (
        <span
          key={`${note.kind}:${note.chain ?? ""}`}
          className="note-badges__item"
          data-note={note.kind}
          data-chain={note.chain}
        >
          <TextTip
            text={number}
            label={`Note ${number}`}
            badge
            interactive={note.interactive}
            align="end"
          >
            <span data-note-text>{note.text}</span>
            {note.tip ? <span data-note-full>{note.tip}</span> : null}
          </TextTip>
        </span>
      ))}
    </span>
  );
}
