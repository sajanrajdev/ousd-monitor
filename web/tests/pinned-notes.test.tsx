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
      container.querySelector(`[data-pinned-notes] [data-note="${kind}"] .tip__badge`)!.textContent;
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

  it("is an ordered list of numbered badges outside any graphic, each with its words as a tooltip", () => {
    render(<PinnedNotes notes={notes} />);
    const list = screen.getByRole("list", { name: "Notes" });
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items[0].closest("[aria-hidden]")).toBeNull();
    const badge = within(items[0]).getByRole("button", { name: "Note 1" });
    expect(badge.textContent).toBe("1");
    expect(badge.className).toContain("tip__badge");
    const panel = document.getElementById(badge.getAttribute("aria-describedby")!)!;
    expect(panel.getAttribute("role")).toBe("tooltip");
    expect(panel.querySelector("[data-note-text]")!.textContent).toBe(
      "On Ethereum, a one-off jump.",
    );
  });

  it("marks each note so a check can find it by what it is and its chain", () => {
    const { container } = render(<PinnedNotes notes={notes} />);
    const warning = container.querySelector('[data-note="velocity-warning"]')!;
    expect(warning.getAttribute("data-chain")).toBe("ethereum");
    expect(container.querySelector('[data-note="placed"]')!.hasAttribute("data-chain")).toBe(false);
  });

  it("puts a note's short words and then the note in full in its badge's tooltip", () => {
    const { container } = render(
      <PinnedNotes
        notes={[{ kind: "day-0", text: "Short words.", tip: "The words in full." }, notes[1]]}
      />,
    );
    const note = container.querySelector('[data-note="day-0"]')!;
    const badge = note.querySelector(".tip__badge")!;
    expect(badge.textContent).toBe("1");
    const panel = document.getElementById(badge.getAttribute("aria-describedby")!)!;
    expect(panel.querySelector("[data-note-text]")!.textContent).toBe("Short words.");
    expect(panel.querySelector("[data-note-full]")!.textContent).toBe("The words in full.");
    expect(container.querySelector('[data-note="placed"] [data-note-full]')).toBeNull();
    expect(container.querySelector(".status-chip")).toBeNull();
  });

  it("makes a badge whose note holds a link a disclosure", () => {
    const { container } = render(
      <PinnedNotes
        notes={[
          {
            kind: "exchange-floor",
            text: "A floor.",
            tip: <a href="/methodology/#x">How</a>,
            interactive: true,
          },
        ]}
      />,
    );
    const badge = container.querySelector(".tip__badge")!;
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(
      document.getElementById(badge.getAttribute("aria-controls")!)!.getAttribute("role"),
    ).toBeNull();
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
