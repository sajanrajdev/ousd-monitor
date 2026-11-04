import type { DatasetState, KpiRow, Verdict } from "@/lib/dataset";
import { definitionHref } from "@/lib/definitions";
import { supportingChip, verdictGroups, verdictSentence } from "@/lib/verdict";
import { Accordion } from "./accordion";
import { FreshnessText } from "./freshness";
import { StatusChip } from "./status-chip";

export type VerdictBlockProps = {
  verdict: Verdict;
  kpis: KpiRow[];
  state: DatasetState;
};

export function VerdictBlock({ verdict, state }: VerdictBlockProps) {
  const groups = verdictGroups(verdict, state.frameWord);
  return (
    <section className="verdict-block" data-section="verdict">
      <p data-section="question">
        Open USD (OUSD) pays partners to distribute it. Is that turning into money that moves?
      </p>
      <h1 style={{ fontSize: "var(--text-display)" }}>{verdictSentence(verdict)}</h1>
      <p className="mt-3">
        <StatusChip kind="opinion" frameWord={state.frameWord} />{" "}
        <a href={definitionHref("verdict")} className="target-link underline underline-offset-4">
          How we read this
        </a>
      </p>
      <p className="mt-4" data-verdict-text>
        <StatusChip kind={supportingChip(verdict)} /> {verdict.text}
      </p>
      <p className="mt-3">
        <FreshnessText fresh={state.asOfLine.fresh} stale={state.asOfLine.stale} />
      </p>
      {groups.length > 0 ? (
        <Accordion title="What this rests on">
          {groups.map((group) => (
            <div key={group.key} className="mt-3" data-verdict-group={group.key}>
              <p className="font-semibold">{group.title}</p>
              <ul className="list-disc pl-5">
                {group.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </Accordion>
      ) : null}
    </section>
  );
}
