"use client";

import { useEffect } from "react";
import { isFreshAt, type FreshnessClock } from "@/lib/dataset/clock";

const RECHECK_MS = 60_000;

// A static page that nobody rebuilds would otherwise never go stale. Sets `data-freshness` on the
// page root once the reader's clock is past the limit, and CSS swaps the text. It can move fresh to
// stale and never back. It receives only the two times it compares.
export function FreshnessWatch({ clock }: { clock: FreshnessClock }) {
  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.freshness === "stale") return;
    const check = () => {
      if (isFreshAt(clock, Date.now())) return false;
      root.dataset.freshness = "stale";
      return true;
    };
    if (check()) return;
    const timer = setInterval(() => {
      if (check()) clearInterval(timer);
    }, RECHECK_MS);
    return () => clearInterval(timer);
  }, [clock]);
  return null;
}

// Both texts are in the server-rendered page, stacked in one grid cell so the taller sets the height
// and nothing shifts when they swap. Fresh text is dated, so it stays true with JavaScript off or in
// an archive. A polite status region, so the change is announced.
export function FreshnessText({ fresh, stale }: { fresh: string | null; stale: string }) {
  return (
    <span className="freshness-text" role="status">
      {fresh === null ? null : <span className="freshness-text__fresh">{fresh}</span>}
      <span className="freshness-text__stale">{stale}</span>
    </span>
  );
}
