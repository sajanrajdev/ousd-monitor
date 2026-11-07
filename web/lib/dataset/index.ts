import "server-only";
import { loadDataset, locateDataset, type Dataset } from "./load.ts";

const loaded = new Map<string, Dataset>();

// Loaded once per build. A failure throws, and a throw while prerendering fails the build.
export function getDataset(): Dataset {
  const location = locateDataset();
  const known = loaded.get(location.dir);
  if (known) return known;
  const dataset = loadDataset(location);
  loaded.set(location.dir, dataset);
  return dataset;
}

export type { Dataset } from "./load.ts";
export type { DatasetState, FrameWord } from "./state.ts";
export type * from "./rows.ts";
