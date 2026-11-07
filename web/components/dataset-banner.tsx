import type { DatasetState } from "@/lib/dataset/state";
import { FreshnessText } from "./freshness";

// Sits under the sticky header and scrolls away. There's nothing to dismiss, and no prop or setting
// hides it: it renders whenever the dataset isn't real.
export function DatasetBanner({ state }: { state: DatasetState }) {
  if (!state.banner) return null;
  return (
    <aside className="dataset-banner" aria-label="About this data" data-dataset-banner>
      <div className="dataset-banner__inner">
        <p className="font-semibold">{state.banner.headline}</p>
        {state.banner.details.map((detail) => (
          <p key={detail}>{detail}</p>
        ))}
      </div>
    </aside>
  );
}

// On every page of sample or preview data, or when a newer run failed, as staleness is about the
// whole site. It's in the page while fresh too, keeping its space, so the reader's clock can reveal
// it with no shift. The main page says this on its own as-of line, so CSS hides this one there. Real
// data that is only old says so in the footer, so a page's title sits right under the header.
export function StaleNote({ state }: { state: DatasetState }) {
  if (state.staleInFooter) return null;
  return (
    <p className="stale-note" data-stale-note>
      <FreshnessText fresh={null} stale={state.asOfLine.stale} />
    </p>
  );
}
