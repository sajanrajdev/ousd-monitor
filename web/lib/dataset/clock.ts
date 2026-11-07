// The clock comparison alone, with no imports, as the one piece of state a client component needs.
export type FreshnessClock = {
  generatedAt: string;
  // The newest reconciliation or transfer time, or null with no reconciliation.
  latestAt: string | null;
  freshUntil: string | null;
};

// A reader's clock, or a chain's block time, can run a little ahead. Further than this isn't drift.
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

// Any time ahead of the clock counts as stale: generated_at at once, the others past the skew.
export function isFreshAt(clock: FreshnessClock, nowMs: number): boolean {
  if (clock.freshUntil === null || Date.parse(clock.generatedAt) > nowMs) return false;
  if (clock.latestAt !== null && Date.parse(clock.latestAt) > nowMs + FUTURE_SKEW_MS) return false;
  return nowMs <= Date.parse(clock.freshUntil);
}
