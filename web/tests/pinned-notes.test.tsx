import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import {
  footnoteId,
  Footnotes,
  NoteMarks,
  orderedNotes,
  pinNumber,
  type PinnedNote,
} from "@/components/pinned-notes";

const notes: PinnedNote[] = [
  {
    kind: "velocity-warning",
    chain: "ethereum",
    text: "On Ethereum, a one-off jump.",
    at: "ethereum",
  },
  { kind: "placed", text: "Placed counts dollars that stayed.", tip: "In full." },
];

describe("footnotes", () => {
  it("numbers notes about the whole card first, then the rest in their order", () => {
    expect(orderedNotes(notes).map((note) => note.kind)).toEqual(["placed", "velocity-warning"]);
    expect(pinNumber(notes, "placed")).toBe(1);
    expect(pinNumber(notes, "velocity-warning", "ethereum")).toBe(2);
  });

  it("puts each marker where its note points, linking to its footnote", () => {
    render(
      <>
        <h2>Title</h2>
        <NoteMarks notes={notes} prefix="card" />
        <p data-testid="ethereum">
          Ethereum <NoteMarks notes={notes} at="ethereum" prefix="card" />
        </p>
        <Footnotes notes={notes} prefix="card" />
      </>,
    );
    const marker = screen.getByRole("link", { name: "Footnote 2" });
    expect(marker.textContent).toBe("2");
    expect(marker.closest("sup")).not.toBeNull();
    expect(screen.getByTestId("ethereum").contains(marker)).toBe(true);
    expect(marker.getAttribute("href")).toBe(`#${footnoteId("card", 2)}`);
    const item = document.getElementById(footnoteId("card", 2))!;
    expect(item.textContent).toBe("On Ethereum, a one-off jump.");
    expect(item.getAttribute("data-chain")).toBe("ethereum");
    expect(screen.getByRole("link", { name: "Footnote 1" }).getAttribute("href")).toBe(
      `#${footnoteId("card", 1)}`,
    );
  });

  it("is a closed details with a Footnotes summary and a numbered list, so it needs no script", () => {
    const { container } = render(<Footnotes notes={notes} prefix="card" />);
    const details = container.querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector(":scope > summary")!.textContent).toBe("Footnotes");
    const list = within(details).getByRole("list", { hidden: true });
    expect(list.tagName).toBe("OL");
    const items = list.querySelectorAll(":scope > li");
    expect(items[0].querySelector("[data-note-text]")!.textContent).toBe(
      "Placed counts dollars that stayed.",
    );
    expect(items[0].querySelector("[data-note-full]")!.textContent).toBe("In full.");
    expect(items[1].querySelector("[data-note-full]")).toBeNull();
  });

  it("has no tooltip on a marker", () => {
    const { container } = render(<NoteMarks notes={notes} prefix="card" />);
    expect(container.querySelector("[data-tip], [role='tooltip'], button")).toBeNull();
  });

  it("renders nothing where no note points, and no list with no notes", () => {
    expect(render(<NoteMarks notes={notes} at="base" prefix="card" />).container.innerHTML).toBe(
      "",
    );
    expect(render(<Footnotes notes={[]} prefix="card" />).container.innerHTML).toBe("");
  });

  it("separates two markers on one row", () => {
    const two: PinnedNote[] = [
      { kind: "a", text: "A.", at: "row" },
      { kind: "b", text: "B.", at: "row" },
    ];
    const { container } = render(<NoteMarks notes={two} at="row" prefix="card" />);
    expect(container.textContent).toBe("1,2");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <main>
        <h2>Title</h2>
        <NoteMarks notes={notes} prefix="card" />
        <ul>
          <li>
            Ethereum <NoteMarks notes={notes} at="ethereum" prefix="card" />
          </li>
        </ul>
        <Footnotes notes={notes} prefix="card" />
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
