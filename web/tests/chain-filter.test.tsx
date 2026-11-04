import { fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { ChainFilter } from "@/components/chain-filter";
import { ChainPanels } from "@/components/chain-panels";
import { ExplainEnhance } from "@/components/explain-enhance";
import { chainOptions } from "@/lib/chain-scope";
import { REQUIRED_CHAINS } from "@/lib/definitions";
import { globalsCss, splitAtHasBlock } from "./css-helpers";

const complete = chainOptions(REQUIRED_CHAINS);
const partial = chainOptions(["tempo", "solana"]);
const css = globalsCss;

describe("the chain filter", () => {
  it("is a named group of native radios, with the first option chosen", () => {
    render(<ChainFilter options={complete} />);
    const group = screen.getByRole("group", { name: "Show a chain" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual([
      "all",
      "tempo",
      "ethereum",
      "base",
      "solana",
    ]);
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false, false, false]);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
  });

  it('reads "All covered" and lists only the chains present, on a partial dataset', () => {
    render(<ChainFilter options={partial} />);
    expect(screen.getByRole("radio", { name: "All covered" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "All" })).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("has its status line empty until a reader changes the filter", () => {
    const { container } = render(
      <>
        <ExplainEnhance />
        <ChainFilter options={complete} />
      </>,
    );
    const status = container.querySelector("[data-chain-status]")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("");
    fireEvent.click(screen.getByRole("radio", { name: "Base" }));
    expect(status.textContent).toBe("Showing Base.");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <main>
        <ChainFilter options={complete} />
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it("has an option at least 36px tall", () => {
    const rule = /\.chain-filter label \{([^}]*)\}/.exec(css)!;
    expect(rule[1]).toContain("min-height: 2.25rem");
  });
});

describe("chain panels", () => {
  it("renders one panel per option, each from that option's own chains", () => {
    const { container } = render(
      <ChainPanels options={partial} id="a-card">
        {(option) => <p>{option.chains.join(" and ")}</p>}
      </ChainPanels>,
    );
    const panels = [...container.querySelectorAll("[data-chain-panel]")];
    expect(panels.map((panel) => panel.getAttribute("data-chain-panel"))).toEqual([
      "all",
      "tempo",
      "solana",
    ]);
    expect(panels.map((panel) => panel.textContent)).toEqual([
      "tempo and solana",
      "tempo",
      "solana",
    ]);
    expect(container.querySelector(".chain-panels")!.id).toBe("a-card");
  });

  it("has a hiding rule for every filter value, and only where :has() is supported", () => {
    const { inside, outside } = splitAtHasBlock(css);
    expect(outside).not.toMatch(/\.chain-panels?\b[^{}]*\{[^}]*display:\s*none/);
    expect(outside).not.toContain("[data-chain-panel");
    for (const value of ["all", ...REQUIRED_CHAINS]) {
      expect(inside).toMatch(
        new RegExp(
          `input\\[value="${value}"\\]:checked\\)\\s+\\.chain-panel:not\\(\\[data-chain-panel="${value}"\\]\\)`,
        ),
      );
    }
  });

  it("hides the filter itself where :has() isn't supported, as it could change nothing", () => {
    expect(css).toMatch(
      /@supports not selector\(:has\(\*\)\) \{\s*\.chain-filter \{\s*display: none;/,
    );
  });

  it("widens panels by the shown panel's toggle, for every filter value, from 1056", () => {
    const { inside } = splitAtHasBlock(css);
    const wide = /@media \(min-width: 1056px\) \{([^}]*)\{\s*grid-column: 1 \/ -1;/.exec(inside)!;
    expect(wide).not.toBeNull();
    expect(wide[1]).toContain(".card-grid > .chart-card:has(> .data-toggle[open])");
    for (const value of ["all", ...REQUIRED_CHAINS]) {
      expect(wide[1]).toMatch(
        new RegExp(
          `input\\[value="${value}"\\]:checked\\)\\s+\\.card-grid\\s+> \\.chain-panels:has\\(> \\[data-chain-panel="${value}"\\] \\.data-toggle\\[open\\]\\)`,
        ),
      );
    }
  });

  it("keeps the chosen option and an open trigger visible in forced colours", () => {
    const forced = /@media \(forced-colors: active\) \{([^}]*\{[^}]*\})/.exec(css)!;
    expect(forced).not.toBeNull();
    expect(forced[1]).toContain(".chain-filter input:checked + span");
    expect(forced[1]).toContain(".info-popover[open] > summary");
    expect(forced[1]).toContain("background: Highlight");
    expect(forced[1]).toContain("color: HighlightText");
  });
});
