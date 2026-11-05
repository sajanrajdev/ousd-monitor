import type {
  ActivityRow,
  ChainRoleRow,
  DatasetState,
  Definitions,
  JourneyRow,
} from "@/lib/dataset";
import { CARD_ANCHORS } from "@/lib/definitions";
import {
  activityChains,
  waterfall,
  waterfallHeading,
  weeklyEveryday,
  weeklyHeading,
} from "@/lib/takeaways/activity";
import { chainRolesHeading } from "@/lib/takeaways/chain-roles";
import { journeyHeading } from "@/lib/takeaways/journey";
import { StatusChip } from "./status-chip";

export type FindingsRowProps = {
  journey: JourneyRow[];
  activity: ActivityRow[];
  chain_roles: ChainRoleRow[];
  definitions: Definitions;
  state: DatasetState;
};

// Each finding is its chart's heading, from the same function, so the two can't disagree. A whole
// card is the link. `data-finding-link` is how ExplainEnhance knows to set the filter to All, since
// a heading is about all the chains it covers. The word stays on each, so one alone reads as not real.
export function FindingsRow({
  journey,
  activity,
  chain_roles,
  definitions,
  state,
}: FindingsRowProps) {
  const chains = activityChains(activity);
  const findings = [
    { id: CARD_ANCHORS.supply, text: journeyHeading(journey, definitions) },
    { id: CARD_ANCHORS.waterfall, text: waterfallHeading(waterfall(activity), chains) },
    { id: CARD_ANCHORS.weekly, text: weeklyHeading(weeklyEveryday(activity), chains) },
    { id: CARD_ANCHORS.chainRoles, text: chainRolesHeading(chain_roles) },
  ];
  return (
    <section className="findings-row" aria-label="Findings" data-section="findings">
      <ul role="list">
        {findings.map(({ id, text }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className="finding"
              data-finding-link
              data-frame={state.frameWord ?? undefined}
            >
              <span className="finding__text">{text}</span>
              <span className="finding__marks">
                <StatusChip kind="inferred" />
                {state.frameWord ? (
                  <strong className="chart-card__frame-word">{state.frameWord}</strong>
                ) : null}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
