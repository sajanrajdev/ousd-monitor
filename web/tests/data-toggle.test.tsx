import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { DataToggle } from "@/components/data-toggle";
import { globalsCss, splitAtHasBlock } from "./css-helpers";

const css = globalsCss;

describe("the data toggle", () => {
  it("is a native details, closed, with its content in the static HTML", () => {
    const { container } = render(
      <DataToggle label="A chart">
        <table data-testid="table" />
      </DataToggle>,
    );
    const details = container.querySelector("details.data-toggle") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.contains(screen.getByTestId("table"))).toBe(true);
  });

  it("opens by click, and the summary holds both words for CSS to swap", () => {
    const { container } = render(<DataToggle label="A chart">x</DataToggle>);
    const summary = container.querySelector("summary")!;
    expect(summary.querySelector(".data-toggle__to-table")!.textContent).toBe("Table");
    expect(summary.querySelector(".data-toggle__to-chart")!.textContent).toBe("Chart");
    fireEvent.click(summary);
    expect((container.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("names what it belongs to for assistive tech, as many cards have one", () => {
    const { container } = render(<DataToggle label="Where supply sits">x</DataToggle>);
    expect(container.querySelector("summary .sr-only")!.textContent).toBe(" for Where supply sits");
  });

  it("hides the plot and keeps the notes, only where :has() is supported", () => {
    const { inside, outside } = splitAtHasBlock(css);
    expect(inside).toContain(".chart-card:has(> .data-toggle[open]) .chart-card__plot");
    expect(outside).not.toContain(".chart-card__plot {");
    expect(css).not.toMatch(/data-toggle\[open\][^{]*pinned-notes[^{]*\{/);
  });

  it('says "Chart" only where opening it swaps the chart out', () => {
    const { inside, outside } = splitAtHasBlock(css);
    expect(outside).toMatch(/\.data-toggle__to-chart \{\s*display: none;/);
    expect(outside).not.toContain(".data-toggle[open] .data-toggle__to-chart");
    expect(inside).toMatch(/\.data-toggle\[open\] \.data-toggle__to-chart \{\s*display: inline;/);
    expect(inside).toMatch(/\.data-toggle\[open\] \.data-toggle__to-table \{\s*display: none;/);
  });

  it("lets a wide table scroll inside its panel rather than clip", () => {
    const panel = /\.data-toggle__panel \{([^}]*)\}/.exec(css)![1];
    expect(panel).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(panel).toContain("overflow-x: auto");
  });

  it("has no axe violations, open", async () => {
    const { container } = render(
      <main>
        <DataToggle label="A chart">x</DataToggle>
      </main>,
    );
    (container.querySelector("details") as HTMLDetailsElement).open = true;
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
