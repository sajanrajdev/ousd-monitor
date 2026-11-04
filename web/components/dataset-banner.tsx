import type { DatasetState } from "@/lib/dataset/state";

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
