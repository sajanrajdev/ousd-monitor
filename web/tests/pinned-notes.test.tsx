import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { NoteBadges, orderedNotes, pinNumber, type PinnedNote } from "@/components/pinned-notes";

const notes: PinnedNote[] = [
  {
    kind: "velocity-warning",
    chain: "ethereum",
    text: "On Ethereum, a one-off jump.",
    at: "ethereum",
  },
  { kind: "placed", text: "Placed counts dollars that stayed." },
];

describe("note badges", () => {
  it("numbers notes about the whole card first, then the rest in their order", () => {
    expect(orderedNotes(notes).map((note) => note.kind)).toEqual(["placed", "velocity-warning"]);
    expect(pinNumber(notes, "placed")).toBe(1);
    expect(pinNumber(notes, "velocity-warning", "ethereum")).toBe(2);
  });

  it("puts each badge where its note points, with the same number everywhere", () => {
    render(
      <>
        <h2>
          Title <NoteBadges notes={notes} />
        </h2>
        <p data-testid="ethereum">
          Ethereum <NoteBadges notes={notes} at="ethereum" />
        </p>
      </>,
    );
    const title = screen.getByRole("heading");
    expect(title.querySelector('[data-note="placed"] .tip__badge')!.textContent).toBe("1");
    expect(title.querySelector('[data-note="velocity-warning"]')).toBeNull();
    const row = screen.getByTestId("ethereum");
    expect(row.querySelector('[data-note="velocity-warning"] .tip__badge')!.textContent).toBe("2");
    expect(row.querySelector('[data-note="placed"]')).toBeNull();
  });

  it("renumbers when a conditional note before it drops out", () => {
    const two: PinnedNote[] = [
      { kind: "day-0", text: "Day 0." },
      { kind: "placed", text: "Placed." },
    ];
    expect(pinNumber(two, "placed")).toBe(2);
    expect(pinNumber(two.slice(1), "placed")).toBe(1);
    expect(pinNumber(two, "velocity-warning", "base")).toBeNull();
  });

  it("numbers two notes of one kind by chain", () => {
    const two: PinnedNote[] = [
      { kind: "velocity-warning", chain: "ethereum", text: "On Ethereum.", at: "ethereum" },
      { kind: "velocity-warning", chain: "base", text: "On Base.", at: "base" },
    ];
    expect(pinNumber(two, "velocity-warning", "base")).toBe(2);
  });

  it("is a named button with its words as a tooltip", () => {
    render(<NoteBadges notes={notes} at="ethereum" />);
    const badge = screen.getByRole("button", { name: "Note 2" });
    expect(badge.textContent).toBe("2");
    expect(badge.className).toContain("tip__badge");
    const panel = document.getElementById(badge.getAttribute("aria-describedby")!)!;
    expect(panel.getAttribute("role")).toBe("tooltip");
    expect(panel.querySelector("[data-note-text]")!.textContent).toBe(
      "On Ethereum, a one-off jump.",
    );
  });

  it("marks each note so a check can find it by what it is and its chain", () => {
    const { container } = render(
      <>
        <NoteBadges notes={notes} />
        <NoteBadges notes={notes} at="ethereum" />
      </>,
    );
    const warning = container.querySelector('[data-note="velocity-warning"]')!;
    expect(warning.getAttribute("data-chain")).toBe("ethereum");
    expect(container.querySelector('[data-note="placed"]')!.hasAttribute("data-chain")).toBe(false);
  });

  it("puts a note's short words and then the note in full in its badge's tooltip", () => {
    const { container } = render(
      <NoteBadges
        notes={[{ kind: "day-0", text: "Short words.", tip: "The words in full." }, notes[1]]}
      />,
    );
    const badge = container.querySelector('[data-note="day-0"] .tip__badge')!;
    expect(badge.textContent).toBe("1");
    const panel = document.getElementById(badge.getAttribute("aria-describedby")!)!;
    expect(panel.querySelector("[data-note-text]")!.textContent).toBe("Short words.");
    expect(panel.querySelector("[data-note-full]")!.textContent).toBe("The words in full.");
    expect(container.querySelector('[data-note="placed"] [data-note-full]')).toBeNull();
  });

  it("makes a badge whose note holds a link a disclosure", () => {
    const { container } = render(
      <NoteBadges
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

  it("renders nothing where no note points", () => {
    const { container } = render(<NoteBadges notes={notes} at="base" />);
    expect(container.innerHTML).toBe("");
  });

  it("has no axe violations beside a title and in a legend row", async () => {
    const { container } = render(
      <main>
        <h2>
          Title <NoteBadges notes={notes} />
        </h2>
        <ul>
          <li>
            Ethereum <NoteBadges notes={notes} at="ethereum" />
          </li>
        </ul>
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
