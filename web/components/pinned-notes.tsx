import type { ReactNode } from "react";
import type { ChainName } from "@/lib/dataset/rows";
import { TextTip } from "./tooltip";

export type PinnedNote = {
  // What the note is, on `data-note`, so a check can find a caveat wherever it is pinned.
  kind: string;
  // Names its chain or part in words, so it reads without the pin.
  text: ReactNode;
  chain?: ChainName;
  // The caveat explained in full, in a tooltip on the note's own words. The words stay the caveat, so
  // nothing a reader needs is only in the tooltip. `interactive` when it holds a link.
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

// Always visible, and outside the graphic. Never in a details, a noscript or a tooltip, which
// verify-output fails.
export function PinnedNotes({ notes }: { notes: PinnedNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ol className="pinned-notes" role="list" data-pinned-notes>
      {notes.map((note, index) => (
        <li key={`${note.kind}:${note.chain ?? ""}`} data-note={note.kind} data-chain={note.chain}>
          <PinMark number={index + 1} />
          <p>
            {note.tip ? (
              <TextTip text={note.text} interactive={note.interactive}>
                {note.tip}
              </TextTip>
            ) : (
              note.text
            )}
          </p>
        </li>
      ))}
    </ol>
  );
}
