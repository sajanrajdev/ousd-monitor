import type { ChainOption } from "@/lib/chain-scope";

// Native radios, so arrow keys work and it needs no script. CSS shows the selected ChainPanels panel.
// The status line stays empty until ExplainEnhance fills it, and without it the radio is announced.
export function ChainFilter({ options }: { options: ChainOption[] }) {
  return (
    <div className="chain-filter" data-section="chain-filter">
      <fieldset>
        <legend className="sr-only">Show a chain</legend>
        {options.map((option, index) => (
          <label key={option.value}>
            <input type="radio" name="chain" value={option.value} defaultChecked={index === 0} />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      <p className="sr-only" role="status" data-chain-status />
    </div>
  );
}
