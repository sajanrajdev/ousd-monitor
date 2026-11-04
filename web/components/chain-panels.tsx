import type { ReactNode } from "react";
import type { ChainOption } from "@/lib/chain-scope";

// One panel per filter option, all in the static HTML, and CSS shows the selected one. Each holds a
// whole card, so the card's frame word and meta come with it. `id` is the card's anchor, on the box
// that is always shown, as a card's own id would repeat in each panel.
export function ChainPanels({
  options,
  id,
  children,
}: {
  options: ChainOption[];
  id?: string;
  children: (option: ChainOption) => ReactNode;
}) {
  return (
    <div className="chain-panels" id={id}>
      {options.map((option) => (
        <div key={option.value} className="chain-panel" data-chain-panel={option.value}>
          {children(option)}
        </div>
      ))}
    </div>
  );
}
