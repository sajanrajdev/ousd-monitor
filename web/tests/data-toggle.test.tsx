import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { DataToggle } from "@/components/data-toggle";

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

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
    const supports = css.slice(css.indexOf("@supports selector(:has(*))"));
    expect(css.indexOf(".chart-card:has(> .data-toggle[open]) .chart-card__plot")).toBeGreaterThan(
      css.indexOf("@supports selector(:has(*))"),
    );
    expect(supports).toContain(".chart-card:has(> .data-toggle[open]) .chart-card__plot");
    expect(css).not.toMatch(/data-toggle\[open\][^{]*(data-pinned-notes|pinned-notes)[^{]*\{/);
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
