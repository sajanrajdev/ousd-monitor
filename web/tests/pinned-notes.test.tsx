import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { Pin, pinNumber, PinnedNotes, type PinnedNote } from "@/components/pinned-notes";

const notes: PinnedNote[] = [
  { kind: "velocity-warning", chain: "ethereum", text: "On Ethereum, a one-off jump." },
  { kind: "placed", text: "Placed counts dollars that stayed." },
];

describe("pins and notes", () => {
  it("lists numbers that match the pins in the chart", () => {
    const { container } = render(
      <>
        <div aria-hidden="true" data-testid="graphic">
          <Pin notes={notes} kind="placed" />
          <Pin notes={notes} kind="velocity-warning" chain="ethereum" />
        </div>
        <PinnedNotes notes={notes} />
      </>,
    );
    const inChart = [...screen.getByTestId("graphic").querySelectorAll(".pin")];
    expect(inChart.map((pin) => pin.textContent)).toEqual(["2", "1"]);
    const numberOf = (kind: string) =>
      container.querySelector(`[data-pinned-notes] [data-note="${kind}"] .pin`)!.textContent;
    expect(numberOf("velocity-warning")).toBe(inChart[1].textContent);
    expect(numberOf("placed")).toBe(inChart[0].textContent);
  });

  it("renumbers the pin when a conditional note before it drops out", () => {
    const without = notes.slice(1);
    expect(pinNumber(notes, "placed")).toBe(2);
    expect(pinNumber(without, "placed")).toBe(1);
    const { container } = render(<Pin notes={without} kind="placed" />);
    expect(container.querySelector(".pin")!.textContent).toBe("1");
  });

  it("draws no pin when its note isn't there, or is on another chain", () => {
    const { container, rerender } = render(<Pin notes={notes.slice(1)} kind="velocity-warning" />);
    expect(container.querySelector(".pin")).toBeNull();
    rerender(<Pin notes={notes} kind="velocity-warning" chain="base" />);
    expect(container.querySelector(".pin")).toBeNull();
    expect(pinNumber(notes, "velocity-warning", "base")).toBeNull();
  });

  it("numbers two notes of one kind by chain", () => {
    const two: PinnedNote[] = [
      { kind: "velocity-warning", chain: "ethereum", text: "On Ethereum." },
      { kind: "velocity-warning", chain: "base", text: "On Base." },
    ];
    expect(pinNumber(two, "velocity-warning", "base")).toBe(2);
  });

  it("is an ordered list with the note's words outside any graphic", () => {
    render(<PinnedNotes notes={notes} />);
    const list = screen.getByRole("list");
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items[0].textContent).toContain("On Ethereum, a one-off jump.");
    expect(items[0].closest("[aria-hidden]")).toBeNull();
  });

  it("marks each note so a check can find it by what it is and its chain", () => {
    const { container } = render(<PinnedNotes notes={notes} />);
    const warning = container.querySelector('[data-note="velocity-warning"]')!;
    expect(warning.getAttribute("data-chain")).toBe("ethereum");
    expect(container.querySelector('[data-note="placed"]')!.hasAttribute("data-chain")).toBe(false);
  });

  it("gives a note its own marker only when it has one", () => {
    const { container } = render(
      <PinnedNotes
        notes={[{ kind: "day-0", chip: "fact", text: "Minted minus burned." }, notes[1]]}
      />,
    );
    expect(container.querySelector('[data-note="day-0"] .status-chip')).not.toBeNull();
    expect(container.querySelector('[data-note="placed"] .status-chip')).toBeNull();
  });

  it("never makes a pin focusable", () => {
    const { container } = render(<Pin notes={notes} kind="placed" />);
    const pin = container.querySelector(".pin")!;
    expect(pin.tagName).toBe("SPAN");
    expect(pin.getAttribute("aria-hidden")).toBe("true");
    expect(pin.hasAttribute("tabindex")).toBe(false);
    expect(pin.closest("a, button")).toBeNull();
  });

  it("renders nothing with no notes, so no number is left over", () => {
    const { container } = render(<PinnedNotes notes={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("has no axe violations with a pin inside an aria-hidden graphic", async () => {
    const { container } = render(
      <main>
        <div aria-hidden="true">
          <Pin notes={notes} kind="placed" />
        </div>
        <PinnedNotes notes={notes} />
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
