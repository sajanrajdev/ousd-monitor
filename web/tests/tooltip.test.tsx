import { act, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplainEnhance } from "@/components/explain-enhance";
import { InfoTip, LinkTip, TextTip } from "@/components/tooltip";

function tips() {
  return render(
    <>
      <ExplainEnhance />
      <div className="explain-head">
        <InfoTip label="About the first">
          <a href="/methodology/#velocity">Definition</a>
        </InfoTip>
      </div>
      <p>
        <TextTip text="Short words">The words in full.</TextTip>
      </p>
      <button>Elsewhere</button>
    </>,
  );
}

const tip = (index: number) => document.querySelectorAll<HTMLElement>("[data-tip]")[index];
const trigger = (index: number) => tip(index).querySelector<HTMLElement>(".tip__trigger")!;
const panel = (index: number) => tip(index).querySelector<HTMLElement>(".tip__panel")!;
const isOpen = (index: number) => "open" in tip(index).dataset;

function mouse(type: "pointerOver" | "pointerOut", target: Element, relatedTarget?: Element) {
  fireEvent[type](target, { pointerType: "mouse", relatedTarget });
}

describe("the tooltip", () => {
  it("is a named disclosure when its panel holds a link", () => {
    render(
      <InfoTip label="About the card">
        <a href="/methodology/#velocity">Definition</a>
      </InfoTip>,
    );
    const button = screen.getByRole("button", { name: "About the card" });
    const id = button.getAttribute("aria-controls")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(id)!.className).toBe("tip__panel");
    expect(document.getElementById(id)!.getAttribute("role")).toBeNull();
  });

  it("is role=tooltip, describing its trigger, when its panel is plain text", () => {
    render(<TextTip text="Short">In full.</TextTip>);
    const button = screen.getByRole("button", { name: "Short" });
    const panel = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(panel.getAttribute("role")).toBe("tooltip");
    expect(panel.textContent).toBe("In full.");
    expect(button.hasAttribute("aria-expanded")).toBe(false);
  });

  it("can hang on a link, which keeps its destination", () => {
    render(
      <LinkTip href="/reconciliation/" text="Reconciled">
        The full sentence.
      </LinkTip>,
    );
    const link = screen.getByRole("link", { name: "Reconciled" });
    expect(link.getAttribute("href")).toBe("/reconciliation/");
    expect(document.getElementById(link.getAttribute("aria-describedby")!)!.textContent).toBe(
      "The full sentence.",
    );
  });

  it("is never a details element, which would push the page down", () => {
    tips();
    expect(document.querySelector("details")).toBeNull();
  });

  it("opens with no script on :hover and :focus-within, until the enhancer takes over", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    expect(css).toMatch(
      /html:not\(\[data-tips\]\) \.tip:is\(:hover, :focus-within\) > \.tip__panel,\s*\.tip\[data-open\] > \.tip__panel \{\s*display: grid;/,
    );
    expect(css).toMatch(/\.tip__panel \{[^}]*position: absolute;/);
  });

  it("has no axe violations, open", async () => {
    const { container } = render(
      <main>
        <InfoTip label="About the card">Text</InfoTip>
        <p>
          <TextTip text="Short">In full.</TextTip>
        </p>
      </main>,
    );
    for (const element of container.querySelectorAll<HTMLElement>("[data-tip]")) {
      element.dataset.open = "";
    }
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe("the enhancer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tips();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const wait = () => act(() => vi.advanceTimersByTime(1000));

  it("says it has taken over from the CSS fallback", () => {
    expect(document.documentElement.dataset.tips).toBe("on");
  });

  it("opens on hover after a delay, and closes after the mouse leaves", () => {
    mouse("pointerOver", trigger(0));
    expect(isOpen(0)).toBe(false);
    wait();
    expect(isOpen(0)).toBe(true);
    expect(trigger(0).getAttribute("aria-expanded")).toBe("true");
    mouse("pointerOut", trigger(0), document.body);
    wait();
    expect(isOpen(0)).toBe(false);
    expect(trigger(0).getAttribute("aria-expanded")).toBe("false");
  });

  it("doesn't open if the mouse leaves before the delay", () => {
    mouse("pointerOver", trigger(0));
    mouse("pointerOut", trigger(0), document.body);
    wait();
    expect(isOpen(0)).toBe(false);
  });

  it.each(["touch", "pen"])("ignores %s hover", (pointerType) => {
    fireEvent.pointerOver(trigger(0), { pointerType });
    wait();
    expect(isOpen(0)).toBe(false);
  });

  it("stays open while the mouse moves onto the panel", () => {
    mouse("pointerOver", trigger(0));
    wait();
    mouse("pointerOut", trigger(0), panel(0));
    mouse("pointerOver", panel(0));
    wait();
    expect(isOpen(0)).toBe(true);
  });

  it("opens on keyboard focus and closes when focus leaves", () => {
    act(() => trigger(1).focus());
    expect(isOpen(1)).toBe(true);
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    expect(isOpen(1)).toBe(false);
  });

  it("keeps a disclosure open while focus moves into its panel", () => {
    act(() => trigger(0).focus());
    act(() => panel(0).querySelector("a")!.focus());
    expect(isOpen(0)).toBe(true);
  });

  it("toggles on tap: the first keeps it open, the second closes it", () => {
    fireEvent.click(trigger(1));
    expect(isOpen(1)).toBe(true);
    mouse("pointerOut", trigger(1), document.body);
    wait();
    expect(isOpen(1)).toBe(true);
    fireEvent.click(trigger(1));
    expect(isOpen(1)).toBe(false);
  });

  it("keeps one open at a time, and hover can't replace one that was clicked", () => {
    fireEvent.click(trigger(0));
    mouse("pointerOver", trigger(1));
    wait();
    expect(isOpen(0)).toBe(true);
    expect(isOpen(1)).toBe(false);
    fireEvent.click(trigger(1));
    expect(isOpen(0)).toBe(false);
    expect(isOpen(1)).toBe(true);
  });

  it("closes on Escape and returns focus to the trigger from inside the panel", () => {
    act(() => trigger(0).focus());
    act(() => panel(0).querySelector("a")!.focus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(isOpen(0)).toBe(false);
    expect(document.activeElement).toBe(trigger(0));
  });

  it("closes on Escape but leaves focus where it is when it's somewhere else", () => {
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    act(() => elsewhere.focus());
    mouse("pointerOver", trigger(1));
    wait();
    expect(isOpen(1)).toBe(true);
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    expect(isOpen(1)).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("keeps one open under the pointer when focus moves elsewhere, and closes a tapped one", () => {
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    mouse("pointerOver", trigger(1));
    wait();
    act(() => elsewhere.focus());
    expect(isOpen(1)).toBe(true);
    act(() => elsewhere.blur());
    mouse("pointerOut", trigger(1), document.body);
    wait();
    expect(isOpen(1)).toBe(false);
    fireEvent.click(trigger(1));
    expect(isOpen(1)).toBe(true);
    act(() => elsewhere.focus());
    expect(isOpen(1)).toBe(false);
  });

  it("closes when the pointer leaves, though a click left focus on its trigger", () => {
    act(() => trigger(1).focus());
    fireEvent.click(trigger(1));
    fireEvent.click(trigger(1));
    expect(isOpen(1)).toBe(false);
    mouse("pointerOver", trigger(1));
    wait();
    expect(isOpen(1)).toBe(true);
    // A mouse click's focus isn't keyboard focus, so it doesn't hold the panel open.
    const matches = trigger(1).matches.bind(trigger(1));
    vi.spyOn(trigger(1), "matches").mockImplementation((selector) =>
      selector === ":focus-visible" ? false : matches(selector),
    );
    mouse("pointerOut", trigger(1), document.body);
    wait();
    expect(isOpen(1)).toBe(false);
  });

  it("closes on an outside click, and stays open on a click inside", () => {
    fireEvent.click(trigger(0));
    fireEvent.click(panel(0));
    expect(isOpen(0)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(isOpen(0)).toBe(false);
  });
});

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

describe("placement", () => {
  afterEach(() => vi.restoreAllMocks());

  function placed(panelBox: DOMRect, triggerBox: DOMRect, above = false) {
    render(
      <>
        <ExplainEnhance />
        <TextTip text="Short" above={above}>
          In full.
        </TextTip>
      </>,
    );
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(390);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(panel(0), "getBoundingClientRect").mockReturnValue(panelBox);
    vi.spyOn(trigger(0), "getBoundingClientRect").mockReturnValue(triggerBox);
    fireEvent.click(trigger(0));
    return {
      shift: panel(0).style.getPropertyValue("--tip-shift"),
      flipped: "flipped" in tip(0).dataset,
    };
  }

  it("shifts a panel back inside the left edge", () => {
    expect(placed(rect(-40, 100, 300, 80), rect(10, 80, 50, 20)).shift).toBe("56px");
  });

  it("shifts a panel back inside the right edge", () => {
    expect(placed(rect(200, 100, 300, 80), rect(200, 80, 50, 20)).shift).toBe("-126px");
  });

  it("leaves a panel that fits where it is", () => {
    expect(placed(rect(20, 100, 300, 80), rect(20, 80, 50, 20)).shift).toBe("");
  });

  it("flips above its trigger when there's no room below and more above", () => {
    expect(placed(rect(20, 780, 300, 200), rect(20, 760, 50, 20)).flipped).toBe(true);
    vi.restoreAllMocks();
  });

  it("stays below when it fits there", () => {
    expect(placed(rect(20, 100, 300, 80), rect(20, 80, 50, 20)).flipped).toBe(false);
  });

  it("prefers above when asked, and flips below only when above has less room", () => {
    expect(placed(rect(20, 0, 300, 200), rect(20, 60, 50, 20), true).flipped).toBe(true);
  });

  it("places an open panel again when the window resizes", () => {
    placed(rect(20, 100, 300, 80), rect(20, 80, 50, 20));
    vi.spyOn(panel(0), "getBoundingClientRect").mockReturnValue(rect(200, 100, 300, 80));
    fireEvent(window, new Event("resize"));
    expect(panel(0).style.getPropertyValue("--tip-shift")).toBe("-126px");
  });
});

describe("a link that carries a tooltip", () => {
  it("navigates on click: it isn't pinned and nothing stops the link", () => {
    render(
      <>
        <ExplainEnhance />
        <LinkTip href="/reconciliation/" text="Reconciled">
          The full sentence.
        </LinkTip>
      </>,
    );
    const link = screen.getByRole("link", { name: "Reconciled" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(isOpen(0)).toBe(false);
  });
});

describe("focus inside an open panel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tips();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps it open when the pointer leaves, while that focus came from the keyboard", () => {
    const link = panel(0).querySelector("a")!;
    const matches = link.matches.bind(link);
    vi.spyOn(link, "matches").mockImplementation((selector) =>
      selector === ":focus-visible" ? true : matches(selector),
    );
    act(() => trigger(0).focus());
    act(() => link.focus());
    mouse("pointerOver", trigger(0));
    act(() => vi.advanceTimersByTime(1000));
    mouse("pointerOut", trigger(0), document.body);
    act(() => vi.advanceTimersByTime(1000));
    expect(isOpen(0)).toBe(true);
  });

  it("can open again by focus once focus has left after Escape", () => {
    act(() => trigger(0).focus());
    act(() => panel(0).querySelector("a")!.focus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(isOpen(0)).toBe(false);
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    act(() => trigger(0).focus());
    expect(isOpen(0)).toBe(true);
  });
});
