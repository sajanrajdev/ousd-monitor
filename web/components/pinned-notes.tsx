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
};

// A note's number is its place in the list, so it's worked out and never written by hand. Null if a
// conditional note dropped out.
export function pinNumber(
  notes: PinnedNote[],
  kind: PinnedNote["kind"],
  chain?: ChainName,
): number | null {
  const index = notes.findIndex((note) => note.kind === kind && note.chain === chain);
  return index === -1 ? null : index + 1;
}

export function PinMark({ number }: { number: number }) {
  return (
    <span className="pin" aria-hidden="true">
      {number}
    </span>
  );
}

// For inside a graphic: the graphic is hidden from assistive tech and out of the tab order, so a pin
// is never a link or anything focusable. It takes the same notes as the list, so the two can't
// disagree, and it draws nothing when its note isn't there.
export function Pin({
  notes,
  kind,
  chain,
}: {
  notes: PinnedNote[];
  kind: PinnedNote["kind"];
  chain?: ChainName;
}) {
  const number = pinNumber(notes, kind, chain);
  return number === null ? null : <PinMark number={number} />;
}

// Numbered badges on the card's last row, one per note, and the card's only markers. Each opens its
// note in the shared tooltip, on hover, focus or tap: the short caveat first, then the note in full.
// This is the maintainer's call after the whole-page review, over the earlier rule that a caveat's
// words stay in view. Never in a details or a noscript, which verify-output fails.
export function PinnedNotes({ notes }: { notes: PinnedNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ol className="note-badges" role="list" aria-label="Notes" data-pinned-notes>
      {notes.map((note, index) => (
        <li key={`${note.kind}:${note.chain ?? ""}`} data-note={note.kind} data-chain={note.chain}>
          <TextTip
            text={index + 1}
            label={`Note ${index + 1}`}
            badge
            interactive={note.interactive}
            align="end"
            above
          >
            <span className="block font-semibold" data-note-text>
              {note.text}
            </span>
            {note.tip ? (
              <span className="mt-1 block" data-note-full>
                {note.tip}
              </span>
            ) : null}
          </TextTip>
        </li>
      ))}
    </ol>
  );
}
