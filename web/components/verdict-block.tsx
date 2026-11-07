import type { DatasetState, KpiRow, Verdict } from "@/lib/dataset";
import { definitionHref } from "@/lib/definitions";
import { verdictGroups, verdictSentence, verdictTextVisible } from "@/lib/verdict";
import { FreshnessText } from "./freshness";
import { InfoTip } from "./tooltip";

export type VerdictBlockProps = {
  verdict: Verdict;
  kpis: KpiRow[];
  state: DatasetState;
};

function VerdictText({ verdict }: { verdict: Verdict }) {
  return <span data-verdict-text>{verdict.text}</span>;
}

// Paragraphs, in the tooltip's panel: the verdict's text if it isn't in view, each group under its
// title, and the link to how the reading is made.
function Reading({ verdict, state }: { verdict: Verdict; state: DatasetState }) {
  const groups = verdictGroups(verdict, state.frameWord);
  return (
    <>
      {verdictTextVisible(verdict, state) ? null : (
        <p>
          <VerdictText verdict={verdict} />
        </p>
      )}
      {groups.map((group) => (
        <div key={group.key} data-verdict-group={group.key}>
          <p className="font-semibold">{group.title}</p>
          {group.items.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      ))}
      <p>
        <a href={definitionHref("verdict")} className="target-link underline underline-offset-4">
          How the reading is made
        </a>
      </p>
    </>
  );
}

// No marker on the headline: the page reads as a reading throughout. A sample or preview still says
// it isn't a finding, in plain words beside the headline, as that's a guard and not a marker. A "?"
// beside the headline opens how we read it. The as-of line under it says when the data is from; on
// real data that's only old, the footer says it's old.
export function VerdictBlock({ verdict, state }: VerdictBlockProps) {
  const textVisible = verdictTextVisible(verdict, state);
  return (
    <section className="verdict-block" data-section="verdict">
      <div className="verdict-block__head">
        <h1>{verdictSentence(verdict)}</h1>
        <InfoTip label="How we read this" icon="help" align="start">
          <Reading verdict={verdict} state={state} />
        </InfoTip>
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
