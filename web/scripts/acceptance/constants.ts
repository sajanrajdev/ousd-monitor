import { fileURLToPath } from "node:url";

export const WEB_DIR = fileURLToPath(new URL("../..", import.meta.url));

export const ALL_WIDTHS = [320, 390, 768, 1056, 1440];

export const AXE_WIDTHS = new Set([390, 1440]);

export const HEIGHT = 900;

export const BREAKPOINT_MD = 768;

export const ONE_LINE_FROM = 1056;

export const NOTES_BESIDE_FROM = 560;

// Each card's anchor, as lib/definitions.ts has them.
export const CARDS = {
  supply: "where-supply-sits",
  series: "placed-vs-circulating",
  waterfall: "headline-to-clean",
  weekly: "everyday-by-week",
  velocity: "velocity-by-chain",
  chainRoles: "what-each-chain-does",
};

export const MIN_TARGET = 24;

export const MIN_FILTER_TARGET = 36;

export const CLOCK_JUMP_MS = 72 * 60 * 60 * 1000;

// The plan's fold, on real data: a sample or preview adds its banner, and may run longer.
// The trust row is gone from a build that passed, and so are the findings, as each card's heading is
// its finding.
export const FOLDS = [
  {
    viewport: { width: 1440, height: 900 },
    above: ["verdict", "kpi-row", "chain-filter"],
    starts: "view-a",
  },
  {
    viewport: { width: 390, height: 844 },
    above: ["verdict", "kpi-row"],
    starts: "chain-filter",
  },
];

// Longer than the enhancer's hover delays, so a panel has had the chance to change.
export const HOVER_SETTLE_MS = 500;

export const STEP_TIMEOUT_MS = 5000;

export const BOX_SLACK_PX = 0.5;

// The frame's hatched edges are pseudo-elements, which leave axe unable to judge the text near them.
export const WITHOUT_FRAME_EDGES = `html[data-frame] body::before, html[data-frame] body::after,
  .chart-card[data-frame]::before { content: none !important; }`;

// The drawer's time, with a margin, before a list's open or closed state can be read.
export const DRAWER_SETTLE_MS = 350;
