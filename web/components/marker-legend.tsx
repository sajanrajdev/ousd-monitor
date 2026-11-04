import { definitionHref } from "@/lib/definitions";
import { InfoPopover } from "./info-popover";
import { MARKERS } from "./status-chip";

const KINDS = ["fact", "inferred", "estimate"] as const;

export function MarkerLegend() {
  return (
    <div className="marker-legend explain-head" data-section="marker-legend">
      <p>
        {KINDS.map((kind, index) => (
          <span key={kind}>
            {index > 0 ? ", " : null}
            <span className="status-chip" data-kind={kind} aria-hidden="true">
              {MARKERS[kind].letter}
            </span>{" "}
            {MARKERS[kind].word}
          </span>
        ))}
      </p>
      <InfoPopover label="What the markers mean">
        <p>
          <strong>Fact:</strong> read directly from the chain.
        </p>
        <p>
          <strong>Inferred:</strong> rests on published labels, or a written rule applied to chain
          data.
        </p>
        <p>
          <strong>Estimate:</strong> rests on a stated assumption.
        </p>
        <p>
          <strong>Our reading:</strong> an opinion about the facts.
        </p>
        <p>
          <a
            href={definitionHref("fact-estimate-opinion")}
            className="target-link underline underline-offset-4"
          >
            Fact, estimate and opinion
          </a>
        </p>
      </InfoPopover>
    </div>
  );
}
