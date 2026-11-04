// The clock comparison alone, with no imports, as the one piece of state a client component needs.
export type FreshnessClock = { generatedAt: string; freshUntil: string | null };

// A generated_at in the future counts as stale.
export function isFreshAt(clock: FreshnessClock, nowMs: number): boolean {
  if (clock.freshUntil === null || Date.parse(clock.generatedAt) > nowMs) return false;
  return nowMs <= Date.parse(clock.freshUntil);
}
