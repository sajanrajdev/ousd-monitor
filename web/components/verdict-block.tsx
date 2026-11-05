import type { DatasetState, KpiRow, Verdict } from "@/lib/dataset";
import { definitionHref } from "@/lib/definitions";
import { supportingChip, verdictGroups, verdictSentence, verdictTextVisible } from "@/lib/verdict";
import { FreshnessText } from "./freshness";
import { InfoPopover } from "./info-popover";
import { StatusChip } from "./status-chip";

export type VerdictBlockProps = {
  verdict: Verdict;
  kpis: KpiRow[];
  state: DatasetState;
};

function VerdictText({ verdict }: { verdict: Verdict }) {
  return (
    <p data-verdict-text>
      <StatusChip kind={supportingChip(verdict)} /> {verdict.text}
    </p>
  );
}

export function VerdictBlock({ verdict, state }: VerdictBlockProps) {
  const groups = verdictGroups(verdict, state.frameWord);
  const textVisible = verdictTextVisible(verdict, state);
  const howWeRead = (
    <a href={definitionHref("verdict")} className="target-link underline underline-offset-4">
      How we read this
    </a>
  );
  return (
    <section className="verdict-block" data-section="verdict">
      <p data-section="question">
        Open USD (OUSD) pays partners to distribute it. Is that turning into money that moves?
      </p>
      <div className="verdict-block__head explain-head">
        <h1>{verdictSentence(verdict)}</h1>
        <StatusChip kind="opinion" frameWord={state.frameWord} />
        <InfoPopover label="About this reading">
          <p>{howWeRead}</p>
          {textVisible ? null : <VerdictText verdict={verdict} />}
          {groups.map((group) => (
            <div key={group.key} data-verdict-group={group.key}>
              <p className="font-semibold">{group.title}</p>
              <ul className="list-disc pl-5">
                {group.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </InfoPopover>
      </div>
      {textVisible ? <VerdictText verdict={verdict} /> : null}
      <p className="verdict-block__as-of">
        <FreshnessText fresh={state.asOfLine.fresh} stale={state.asOfLine.stale} />
      </p>
      <noscript>
        <p className="verdict-block__as-of">{howWeRead}</p>
      </noscript>
    </section>
  );
}
