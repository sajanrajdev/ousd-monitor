import type { DatasetState, KpiRow, Verdict } from "@/lib/dataset";
import { definitionHref } from "@/lib/definitions";
import { verdictGroups, verdictSentence, verdictTextVisible } from "@/lib/verdict";
import { FreshnessText } from "./freshness";
import { TextTip } from "./tooltip";

export type VerdictBlockProps = {
  verdict: Verdict;
  kpis: KpiRow[];
  state: DatasetState;
};

function VerdictText({ verdict }: { verdict: Verdict }) {
  return <span data-verdict-text>{verdict.text}</span>;
}

// Phrasing content only, as the tooltip's panel is a span.
function Reading({ verdict, state }: { verdict: Verdict; state: DatasetState }) {
  const groups = verdictGroups(verdict, state.frameWord);
  return (
    <>
      {verdictTextVisible(verdict, state) ? null : (
        <span className="block">
          <VerdictText verdict={verdict} />
        </span>
      )}
      {groups.map((group) => (
        <span key={group.key} className="block" data-verdict-group={group.key}>
          <span className="block font-semibold">{group.title}</span>
          {group.items.map((item) => (
            <span key={item} className="block">
              {item}
            </span>
          ))}
        </span>
      ))}
      <a href={definitionHref("verdict")} className="target-link underline underline-offset-4">
        How the reading is made
      </a>
    </>
  );
}

// No marker on the headline: the page reads as a reading throughout. A sample or preview still says
// it isn't a finding, in plain words beside the headline, as that's a guard and not a marker. The
// as-of line is the page's state line on a dataset that passed at build, so it carries the
// reconciled time too once the reader's clock says it's old.
export function VerdictBlock({ verdict, state }: VerdictBlockProps) {
  const textVisible = verdictTextVisible(verdict, state);
  return (
    <section className="verdict-block" data-section="verdict">
      <p data-section="question">Is Open USD (OUSD) supply turning into money that moves?</p>
      <div className="verdict-block__head">
        <h1>{verdictSentence(verdict)}</h1>
        <TextTip text="How we read this" interactive>
          <Reading verdict={verdict} state={state} />
        </TextTip>
        {state.frameWord ? (
          <p className="verdict-block__frame" data-verdict-frame>
            {`${state.frameWord}, not a finding.`}
          </p>
        ) : null}
      </div>
      {textVisible ? (
        <p>
          <VerdictText verdict={verdict} />
        </p>
      ) : null}
      <p className="verdict-block__as-of">
        <FreshnessText fresh={state.asOfLine.fresh} stale={state.headStale} />
      </p>
      <noscript>
        <p className="verdict-block__as-of">
          <a href={definitionHref("verdict")} className="target-link underline underline-offset-4">
            How we read this
          </a>
        </p>
      </noscript>
    </section>
  );
}
