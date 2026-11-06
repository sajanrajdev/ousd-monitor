import { useId, type ReactNode } from "react";

// The one tooltip on the site. Its panel floats over the page and moves nothing. It opens on hover
// and on keyboard focus, toggles on tap, and closes on Escape and when focus or the pointer leaves,
// all from ExplainEnhance. With no script, CSS opens it on :hover and :focus-within, so its content
// is still reached. A panel that holds a link is a disclosure, with aria-expanded, and focus can
// move into it. A panel of plain text is role="tooltip" and describes its trigger. Never the only
// copy of a finding, a caveat needed to read a number, or a stale, sample, preview or partial
// message: verify-output reads a panel as out of view.
type Place = { align?: "start" | "end"; above?: boolean };

function panelProps(id: string, interactive: boolean, children: ReactNode) {
  return {
    id,
    className: "tip__panel",
    ...(interactive ? {} : { role: "tooltip" }),
    children,
  };
}

function triggerProps(id: string, interactive: boolean) {
  return interactive ? { "aria-expanded": false, "aria-controls": id } : { "aria-describedby": id };
}

function placeProps({ align = "start", above = false }: Place) {
  return { "data-align": align, "data-above": above ? "" : undefined };
}

// An "i" button with a name, for a card's, a KPI's or a cell's head, or a "?" for how to read the
// headline. Its panel may hold blocks and links, so it sits in a div.
export function InfoTip({
  label,
  children,
  icon = "info",
  ...place
}: { label: string; children: ReactNode; icon?: "info" | "help" } & Place) {
  const id = useId();
  return (
    <div className="tip tip--info" data-tip {...placeProps({ align: "end", ...place })}>
      <button
        type="button"
        className={`tip__trigger tip__icon${icon === "help" ? " tip__icon--help" : ""}`}
        aria-label={label}
        {...triggerProps(id, true)}
      />
      <div {...panelProps(id, true, children)} />
    </div>
  );
}

// Visible words that open their own explanation, inside running text. Phrasing content only, as it
// sits inside a paragraph. `interactive` when the explanation holds a link. `label` names a trigger
// whose words alone don't say what it opens.
export function TextTip({
  text,
  children,
  interactive = false,
  label,
  ...place
}: {
  text: ReactNode;
  children: ReactNode;
  interactive?: boolean;
  label?: string;
} & Place) {
  const id = useId();
  return (
    <span className="tip tip--text" data-tip {...placeProps(place)}>
      <button
        type="button"
        className="tip__trigger tip__words"
        aria-label={label}
        {...triggerProps(id, interactive)}
      >
        {text}
      </button>
      <span {...panelProps(id, interactive, children)} />
    </span>
  );
}

// A link whose destination is the detail, with a sentence about it on hover and focus.
export function LinkTip({
  href,
  text,
  children,
  className = "",
  ...place
}: { href: string; text: ReactNode; children: ReactNode; className?: string } & Place) {
  const id = useId();
  return (
    <span className="tip tip--link" data-tip {...placeProps(place)}>
      <a href={href} className={`tip__trigger ${className}`.trim()} {...triggerProps(id, false)}>
        {text}
      </a>
      <span {...panelProps(id, false, children)} />
    </span>
  );
}
