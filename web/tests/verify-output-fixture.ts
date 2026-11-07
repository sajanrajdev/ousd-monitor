// The planted sites and expectations the verify-output tests share. Each group of tests is a file of
// its own, so a CI worker of its own: in one file they ran out of memory.
import { readFileSync } from "node:fs";
import { TOKEN_CONTRACTS } from "@/lib/definitions";
import { plantFile, tempDir } from "./dataset-helpers";
import {
  PLANTED_INDEPENDENCE,
  PLANTED_KPI_SCOPE,
  PLANTED_KPI_VALUES,
  PLANTED_TRUST_LINK,
  PLANTED_VERDICT,
  type PlantedBand,
  type PlantedRow,
  type PlantedSeriesPanel,
  PlantedWaterfallPanel,
  PlantedWeeklyPanel,
  type PlantedSupplyPanel,
  plantedCard,
  plantedFlight,
  plantedFooter,
  plantedHeadline,
  plantedKpis,
  plantedReconciliationMain,
  ICON_LINKS,
  PLANTED_HEADER,
  plantedBack,
} from "./planted-first-screen";

export const LINE = PLANTED_INDEPENDENCE;
export const BLOCKED = JSON.parse(readFileSync("scripts/blocked-names.json", "utf8")) as string[];
export const CARD = plantedCard("Sample");

export const STALE_NOTE = "Data from 4 Nov. Nothing newer has reached this page.";
export const STALE_TRUST = "Last reconciled 4 Nov. Nothing newer has reached this page.";
export const SHORT_TRUST = "Last reconciled 4 Nov";
export const FRESH_TRUST = "Supply reconciled on all 4 chains as of 4 Nov 2026, 05:30 UTC";
// Real data that's only old: its as-of line says when the data is from, and the footer says it's old.
export const HEAD_STALE = "Data from 4 Nov.";
export const RUN_FRESH = "Last run 4 Nov 2026, 05:30 UTC: every check passed.";
export const RUN_STALE =
  "Last run 4 Nov 2026, 05:30 UTC: every check passed. Nothing newer has reached this page.";
export const SAMPLE_RUN = "Sample figures, not a reconciliation.";

export const sampleExpected = {
  kind: "sample",
  frameWord: "Sample",
  version: "20261104T060000Z",
  pipelineStrings: [
    "Sample check detail for chain_supply.",
    'A "quoted" reason, for the serialized case',
  ],
  blockedNames: BLOCKED,
  tokenContracts: TOKEN_CONTRACTS,
  freshness: "stale",
  passing: false,
  asOfLine: { fresh: null, stale: STALE_NOTE },
  headStale: STALE_NOTE,
  trustLine: { fresh: "Not reconciled", stale: "Not reconciled" } as {
    fresh: string | null;
    stale: string;
    short?: string;
  },
  staleInFooter: false,
  runLine: { fresh: SAMPLE_RUN, stale: SAMPLE_RUN } as { fresh: string | null; stale: string },
  checkCount: 7,
  verdict: PLANTED_VERDICT,
  kpiScope: PLANTED_KPI_SCOPE,
  kpiValues: PLANTED_KPI_VALUES,
  essentialNotes: [] as { kind: string; chain?: string; text: string }[],
  exchangeRows: [] as PlantedRow[],
  bands: [] as PlantedBand[],
  filter: [] as { value: string; label: string }[],
  supplyPanels: [] as PlantedSupplyPanel[],
  seriesPanels: [] as PlantedSeriesPanel[],
  waterfallPanels: [] as PlantedWaterfallPanel[],
  weeklyPanels: [] as PlantedWeeklyPanel[],
  velocity: null,
  grid: null,
};

// Real data after a newer run failed its checks: the trust row and stale note stay at the top.
export const realExpected = {
  ...sampleExpected,
  kind: "real",
  frameWord: null,
  trustLine: { fresh: null, stale: STALE_TRUST, short: SHORT_TRUST },
  runLine: { fresh: null, stale: RUN_STALE },
  verdict: { ...PLANTED_VERDICT, textVisible: false },
};

// A passing build. Once old, it says so in the footer alone.
export const freshRealExpected = {
  ...realExpected,
  freshness: "fresh",
  passing: true,
  staleInFooter: true,
  asOfLine: { fresh: "Data as of 3 Nov 2026 UTC.", stale: STALE_NOTE },
  headStale: HEAD_STALE,
  trustLine: { fresh: FRESH_TRUST, stale: STALE_TRUST, short: SHORT_TRUST },
  runLine: { fresh: RUN_FRESH, stale: RUN_STALE },
};

export const REPORTS = '<a href="https://example.com/r" rel="noopener noreferrer">Reports</a>';
export const SAMPLE_FOOTER = plantedFooter(false, sampleExpected.trustLine, REPORTS);
export const REAL_FOOTER = plantedFooter(false, realExpected.trustLine, REPORTS);
export const FRESH_FOOTER = plantedFooter(true, freshRealExpected.trustLine, REPORTS);

export function page(
  body: string,
  attrs = 'data-dataset-kind="sample" data-dataset-version="20261104T060000Z" data-frame="Sample" data-freshness="stale"',
  title = "[Sample] Open USD Monitor",
  head = `<meta name="robots" content="noindex, nofollow"/>${ICON_LINKS}`,
  footer = SAMPLE_FOOTER,
) {
  return `<!doctype html><html ${attrs}><head><title>${title}</title>${head}</head><body>
    ${PLANTED_HEADER}
    <aside data-dataset-banner>Sample data. Nothing here is real.</aside>
    <p data-stale-note>${STALE_NOTE}</p>
    ${plantedFlight([["$", "main", null, {}]])}
    ${body}
    ${footer}</body></html>`;
}

export const MAIN = `<main><section data-section="trust-strip">Not reconciled${PLANTED_TRUST_LINK}</section>
  <section data-section="verdict">${plantedHeadline()}
  <p data-verdict-frame>Sample, not a finding.</p><p>${STALE_NOTE}</p></section>
  <section data-section="kpi-row"><strong>Sample</strong>${plantedKpis()}</section>
  ${CARD}</main>`;

// The detail page, in the same frame, state and footer as the methodology page planted beside it, so
// a test that changes only that page or the main page leaves it right.
export function reconciliationLike(methodology: string): string {
  const attrs = /<html ([^>]*)>/.exec(methodology)?.[1] ?? "";
  const footer = /<footer>[^]*<\/footer>/.exec(methodology)?.[0] ?? SAMPLE_FOOTER;
  const frame = /data-frame="(\w+)"/.exec(attrs)?.[1];
  const line = attrs.includes('data-dataset-kind="real"')
    ? attrs.includes('data-freshness="fresh"')
      ? `${RUN_FRESH} ${RUN_STALE}`
      : RUN_STALE
    : SAMPLE_RUN;
  const html = withStaleNoteOf(
    methodology,
    page(
      plantedReconciliationMain(line),
      attrs,
      frame ? `[${frame}] Open USD Monitor` : "Open USD Monitor",
      `${frame ? '<meta name="robots" content="noindex, nofollow"/>' : ""}${ICON_LINKS}`,
      footer,
    ),
  );
  return frame
    ? html
    : html.replace("<aside data-dataset-banner>Sample data. Nothing here is real.</aside>", "");
}

// A stale note at the top only where the page beside it has one, as real data that's only old has
// none.
export function withStaleNoteOf(beside: string, html: string): string {
  return beside.includes("data-stale-note")
    ? html
    : html.replace(/<p data-stale-note>.*?<\/p>/, "");
}

export function site(
  overrides: {
    main?: string;
    methodology?: string;
    reconciliation?: string | null;
    extra?: [string, string][];
  } = {},
) {
  const dir = tempDir();
  const methodology = overrides.methodology ?? page("<main>Methodology</main>");
  plantFile(dir, "index.html", overrides.main ?? page(MAIN));
  plantFile(dir, "favicon.ico", "ico");
  plantFile(dir, "icon.svg", "<svg/>");
  plantFile(dir, "methodology/index.html", plantedBack(methodology));
  if (overrides.reconciliation !== null) {
    plantFile(
      dir,
      "reconciliation/index.html",
      overrides.reconciliation ?? reconciliationLike(methodology),
    );
  }
  for (const [path, content] of overrides.extra ?? []) plantFile(dir, path, content);
  return dir;
}

export function mainWith(body: string) {
  return site({ main: page(`${MAIN}${body}`) });
}

export const realAttrs =
  'data-dataset-kind="real" data-dataset-version="20261104T060000Z" data-freshness="stale"';
export const REAL_HEADLINE = plantedHeadline(realExpected.verdict);
export const REAL_REST = `<section data-section="kpi-row">${plantedKpis()}</section>${plantedCard(null)}`;
export const REAL_MAIN = `<main><section data-section="trust-strip">${STALE_TRUST}${PLANTED_TRUST_LINK}</section>
  <section data-section="verdict">${REAL_HEADLINE}<p>${STALE_NOTE}</p></section>${REAL_REST}</main>`;
// A passing build: no trust row or stale note at the top, and its as-of line says only when the data
// is from.
export const FRESH_MAIN = `<main><section data-section="verdict">${REAL_HEADLINE}<p>Data as of 3 Nov 2026 UTC.</p><p>${HEAD_STALE}</p></section>${REAL_REST}</main>`;

export function realPage(body: string, footer = REAL_FOOTER) {
  return page(body, realAttrs, "Open USD Monitor", ICON_LINKS, footer).replace(
    "<aside data-dataset-banner>Sample data. Nothing here is real.</aside>",
    "",
  );
}

export const freshPage = (body: string) =>
  realPage(body, FRESH_FOOTER)
    .replace('data-freshness="stale"', 'data-freshness="fresh"')
    .replace(/<p data-stale-note>.*?<\/p>/, "");
