import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { Pin, PinnedNotes, type PinnedNote } from "@/components/pinned-notes";

const notes: PinnedNote[] = [
  { kind: "velocity-warning", chain: "ethereum", text: "On Ethereum, a one-off jump." },
  { kind: "placed", text: "Placed counts dollars that stayed." },
];

describe("pins and notes", () => {
  it("lists numbers that match the pins in the chart", () => {
    const { container } = render(
      <>
        <div aria-hidden="true" data-testid="graphic">
          <Pin number={1} />
          <Pin number={2} />
        </div>
        <PinnedNotes notes={notes} />
      </>,
    );
    const inChart = [...screen.getByTestId("graphic").querySelectorAll(".pin")];
    const inList = [...container.querySelectorAll("[data-pinned-notes] > li > .pin")];
    expect(inList.map((pin) => pin.textContent)).toEqual(["1", "2"]);
    expect(inList.map((pin) => pin.textContent)).toEqual(inChart.map((pin) => pin.textContent));
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
    const { container } = render(<Pin number={1} />);
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
          <Pin number={1} />
        </div>
        <PinnedNotes notes={notes} />
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
