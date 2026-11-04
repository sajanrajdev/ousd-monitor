import type { ReactNode } from "react";
import type { ChainName } from "@/lib/dataset/rows";
import { StatusChip, type ChipKind } from "./status-chip";

export type PinnedNote = {
  // What the note is, on `data-note`, so a check can find a caveat wherever it is pinned.
  kind: string;
  // Names its chain or part in words, so it reads without the pin.
  text: ReactNode;
  chain?: ChainName;
  // Only when the note differs from its card's marker.
  chip?: ChipKind;
};

// For inside a graphic: the graphic is hidden from assistive tech and out of the tab order, so a pin
// is never a link or anything focusable.
export function Pin({ number }: { number: number }) {
  return (
    <span className="pin" aria-hidden="true">
      {number}
    </span>
  );
}

// Always visible, and outside the graphic. A pin in a chart takes its note's place in this list as
// its number. Never in a details or noscript, which verify-output fails.
export function PinnedNotes({ notes }: { notes: PinnedNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ol className="pinned-notes" role="list" data-pinned-notes>
      {notes.map((note, index) => (
        <li key={`${note.kind}:${note.chain ?? ""}`} data-note={note.kind} data-chain={note.chain}>
          <Pin number={index + 1} />
          <p>
            {note.chip ? (
              <>
                <StatusChip kind={note.chip} />{" "}
              </>
            ) : null}
            {note.text}
          </p>
        </li>
      ))}
    </ol>
  );
}
