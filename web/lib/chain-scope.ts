import { CHAIN_NAMES, REQUIRED_CHAINS } from "./definitions.ts";
import type { ChainName } from "./dataset/rows.ts";

export type ChainOption = {
  value: "all" | ChainName;
  label: string;
  // The chains a panel for this option reads. Under All it is every chain in the dataset.
  chains: ChainName[];
};

// All, then each chain in the dataset. A partial dataset's first option never reads "All", because
// it isn't all of them.
export function chainOptions(chainsIncluded: readonly ChainName[]): ChainOption[] {
  const chains = REQUIRED_CHAINS.filter((chain) => chainsIncluded.includes(chain));
  const label = chains.length === REQUIRED_CHAINS.length ? "All" : "All covered";
  return [
    { value: "all", label, chains },
    ...chains.map((chain) => ({ value: chain, label: CHAIN_NAMES[chain], chains: [chain] })),
  ];
}
