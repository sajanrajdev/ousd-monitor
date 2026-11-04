import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { MarkerLegend } from "@/components/marker-legend";
import { StatusChip } from "@/components/status-chip";

describe("the marker", () => {
  it.each([
    ["fact", "F", "Fact"],
    ["inferred", "I", "Inferred"],
    ["estimate", "E", "Estimate"],
  ] as const)("shows %s as its letter, with the full word in the DOM", (kind, letter, word) => {
    const { container } = render(<StatusChip kind={kind} />);
    const chip = container.querySelector(".status-chip")!;
    expect(chip.getAttribute("data-kind")).toBe(kind);
    expect(chip.querySelector('[aria-hidden="true"]')!.textContent).toBe(letter);
    expect(chip.querySelector(".sr-only")!.textContent).toBe(word);
  });

  it("spells an opinion out, and says it isn't a finding on a frame", () => {
    const { container, rerender } = render(<StatusChip kind="opinion" />);
    expect(container.querySelector(".status-chip")!.textContent).toBe("Our reading");
    rerender(<StatusChip kind="opinion" frameWord="Sample" />);
    expect(container.querySelector(".status-chip")!.textContent).toBe("Sample, not a finding");
    rerender(<StatusChip kind="opinion" frameWord="Preview" />);
    expect(container.querySelector(".status-chip")!.textContent).toBe("Preview, not a finding");
  });
});

describe("the marker legend", () => {
  it("reads the three letters and their words, on the visible line", () => {
    const { container } = render(<MarkerLegend />);
    const line = container.querySelector('[data-section="marker-legend"] > p')!;
    expect(line.textContent).toBe("F Fact, I Inferred, E Estimate");
    expect(line.closest("details")).toBeNull();
  });

  it("explains all four in its popover, and links the definition", () => {
    const { container } = render(<MarkerLegend />);
    const panel = container.querySelector(".info-popover__panel") as HTMLElement;
    for (const word of ["Fact:", "Inferred:", "Estimate:", "Our reading:"]) {
      expect(panel.textContent).toContain(word);
    }
    const link = within(panel).getByRole("link", { hidden: true });
    expect(link.getAttribute("href")).toBe("/methodology/#fact-estimate-opinion");
    expect(container.querySelector("summary")!.getAttribute("aria-label")).toBe(
      "What the markers mean",
    );
  });

  it("has no axe violations, open", async () => {
    const { container } = render(
      <main>
        <MarkerLegend />
      </main>,
    );
    (container.querySelector("details") as HTMLDetailsElement).open = true;
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
    expect(screen.getByRole("link")).toBeTruthy();
  });
});
