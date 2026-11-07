import type { KpiRow, ManifestWarning } from "../../lib/dataset/index.ts";
import type { Expected } from "./expected.ts";
import { CARD_ANCHORS, CHAIN_NAMES } from "../../lib/definitions.ts";
import { formatBps, UNKNOWN_TEXT } from "../../lib/format.ts";
import { velocityHeading } from "../../lib/takeaways/activity.ts";
import { JUMPY_NOTE, VELOCITY_NOTE, WALLETS_NOTE } from "../../lib/takeaways/caveats.ts";
import { velocityChart } from "../../lib/chain-views.ts";
import { plainText, viewText } from "./dom.ts";
import { checkHeadingOf, checkPanelNotes } from "./panels.ts";

// What the velocity chart must print, worked out here from the KPI rows with no code the chart uses,
// so a fault in its scale or its order can't set what this check expects: chains in the site's
// order, three measures each, on one linear scale from zero to the largest figure.
const VELOCITY_FIELDS = ["velocity_bps", "velocity_everyday_bps", "headline_velocity_bps"] as const;

export function velocityExpected(kpis: KpiRow[], warnings: ManifestWarning[]) {
  const order = Object.keys(CHAIN_NAMES);
  const rows = [...kpis].sort((a, b) => order.indexOf(a.chain) - order.indexOf(b.chain));
  const values = rows
    .flatMap((row) => VELOCITY_FIELDS.map((field) => row[field]))
    .filter((v): v is number => v !== null);
  const max = values.length > 0 ? Math.max(...values) : null;
  const width = (bps: number | null) =>
    bps === null || max === null
      ? null
      : max === 0
        ? 0
        : Number((BigInt(bps) * 10_000n) / BigInt(max));
  const chart = velocityChart(kpis, warnings);
  return {
    heading: velocityHeading(kpis),
    bars:
      max === null
        ? []
        : rows.flatMap((row) =>
            VELOCITY_FIELDS.map(
              (field) =>
                `${row.chain}:${field}=${row[field] === null ? UNKNOWN_TEXT : formatBps(row[field])}@${width(row[field])}`,
            ),
          ),
    notes: chart.notes.map(({ kind, chain, text, tip }) => ({
      kind,
      chain,
      words: text,
      tip,
      at: chart.max === null ? undefined : chain,
    })),
    fullWarnings: chart.fullWarnings,
  };
}

// Velocity by chain: each bar's figure and width, each warning's pin beside its own chain and
// nowhere else, the notes in view with their words, each warning whole in the tooltip, and the
// wallet counts' caveat in the caption of the table that holds them.
export function checkVelocity(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  if (!expected.velocity) return;
  const card = document.querySelector(`[id="${CARD_ANCHORS.velocity}"]`);
  const where = `${page}: #${CARD_ANCHORS.velocity}`;
  if (!card) {
    problems.push(`${where}: missing`);
    return;
  }
  const want = expected.velocity;
  checkHeadingOf(where, card, want.heading, problems);
  const bars = [...card.querySelectorAll<HTMLElement>("[data-velocity-chain] [data-measure]")].map(
    (row) => {
      const chain = row.closest<HTMLElement>("[data-velocity-chain]")!.dataset.velocityChain;
      const bar = row.querySelector<HTMLElement>(".velocity-chart__bar");
      const width = bar ? Number(bar.dataset.width) : null;
      const value = viewText(row.querySelector("[data-velocity-value]")).trim();
      return `${chain}:${row.dataset.measure}=${value}@${width}`;
    },
  );
  // A bar of zero width draws nothing, as one with no figure does.
  const drawn = want.bars.map((bar) => bar.replace(/@0$/, "@null"));
  if (bars.join() !== drawn.join()) problems.push(`${where}: its bars aren't the dataset's`);
  checkPanelNotes(where, card, want.notes, problems);
  for (const [kind, words] of [
    ["velocity-denominators", VELOCITY_NOTE],
    ["velocity-jumpy", JUMPY_NOTE],
  ]) {
    const full = card.querySelector(`.tip__panel [data-full-note="${kind}"]`);
    if (!full?.textContent.includes(words)) {
      problems.push(`${where}: its tooltip has lost the ${kind} note in full`);
    }
  }
  for (const { chain, text } of want.fullWarnings) {
    const full = card.querySelector(
      `.tip__panel [data-full-note="velocity-warning"][data-chain="${chain}"]`,
    );
    if (plainText(full) !== text)
      problems.push(`${where}: its tooltip has lost ${chain}'s warning`);
  }
  const caption = card.querySelector(".data-toggle table caption");
  if (!caption?.textContent.includes(WALLETS_NOTE)) {
    problems.push(`${where}: its table of wallets doesn't say what a wallet is`);
  }
}
