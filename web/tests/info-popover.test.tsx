import { act, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplainEnhance } from "@/components/explain-enhance";
import { InfoPopover } from "@/components/info-popover";

function popovers() {
  return render(
    <>
      <ExplainEnhance />
      <div className="explain-head">
        <InfoPopover label="About the first">
          <a href="/methodology/#velocity">Definition</a>
        </InfoPopover>
      </div>
      <div className="explain-head">
        <InfoPopover label="About the second">Second</InfoPopover>
      </div>
      <button>Elsewhere</button>
    </>,
  );
}

const details = (index: number) =>
  document.querySelectorAll<HTMLDetailsElement>(".info-popover")[index];
const trigger = (index: number) => details(index).querySelector("summary")!;
const panel = (index: number) => details(index).querySelector(".info-popover__panel")!;

function mouse(type: "pointerOver" | "pointerOut", target: Element, relatedTarget?: Element) {
  fireEvent[type](target, { pointerType: "mouse", relatedTarget });
}

describe("the info popover", () => {
  it("names its trigger, and shares one name so one opens at a time", () => {
    render(
      <InfoPopover label="About the card">
        <a href="/methodology/#velocity">Definition</a>
      </InfoPopover>,
    );
    const summary = document.querySelector("summary")!;
    expect(summary.getAttribute("aria-label")).toBe("About the card");
    expect(document.querySelector("details")!.getAttribute("name")).toBe("info");
    expect(screen.getByRole("link", { hidden: true }).getAttribute("href")).toBe(
      "/methodology/#velocity",
    );
  });

  it("opens by click with no enhancer at all", () => {
    render(<InfoPopover label="About">x</InfoPopover>);
    fireEvent.click(document.querySelector("summary")!);
    expect(document.querySelector("details")!.open).toBe(true);
  });

  it("has no axe violations, open", async () => {
    const { container } = render(
      <main>
        <InfoPopover label="About the card">Text</InfoPopover>
      </main>,
    );
    container.querySelector("details")!.open = true;
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe("the enhancer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    popovers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const wait = () => act(() => vi.advanceTimersByTime(1000));

  it("opens on hover after a delay, and closes after the mouse leaves", () => {
    mouse("pointerOver", trigger(0));
    expect(details(0).open).toBe(false);
    wait();
    expect(details(0).open).toBe(true);
    mouse("pointerOut", trigger(0), document.body);
    wait();
    expect(details(0).open).toBe(false);
  });

  it("doesn't open if the mouse leaves before the delay", () => {
    mouse("pointerOver", trigger(0));
    mouse("pointerOut", trigger(0), document.body);
    wait();
    expect(details(0).open).toBe(false);
  });

  it.each(["touch", "pen"])("ignores %s hover", (pointerType) => {
    fireEvent.pointerOver(trigger(0), { pointerType });
    wait();
    expect(details(0).open).toBe(false);
  });

  it("does open for a mouse by the same event, so the two above test something", () => {
    fireEvent.pointerOver(trigger(0), { pointerType: "mouse" });
    wait();
    expect(details(0).open).toBe(true);
  });

  it("stays open while the mouse moves onto the panel", () => {
    mouse("pointerOver", trigger(0));
    wait();
    mouse("pointerOut", trigger(0), document.body);
    mouse("pointerOver", panel(0));
    wait();
    expect(details(0).open).toBe(true);
  });

  it("keeps a hover-opened panel open on the first click, then closes on the next", () => {
    mouse("pointerOver", trigger(0));
    wait();
    fireEvent.click(trigger(0));
    expect(details(0).open).toBe(true);
    mouse("pointerOut", trigger(0), document.body);
    wait();
    expect(details(0).open).toBe(true);
    fireEvent.click(trigger(0));
    expect(details(0).open).toBe(false);
  });

  it("pins on a click inside the panel too", () => {
    mouse("pointerOver", trigger(0));
    wait();
    mouse("pointerOver", panel(0));
    fireEvent.click(panel(0));
    mouse("pointerOut", panel(0), document.body);
    wait();
    expect(details(0).open).toBe(true);
  });

  it("doesn't let hover replace one that was clicked open", () => {
    fireEvent.click(trigger(0));
    mouse("pointerOver", trigger(1));
    wait();
    expect(details(0).open).toBe(true);
    expect(details(1).open).toBe(false);
  });

  it("moves between hover-opened popovers", () => {
    mouse("pointerOver", trigger(0));
    wait();
    mouse("pointerOut", trigger(0), trigger(1));
    mouse("pointerOver", trigger(1));
    wait();
    expect(details(0).open).toBe(false);
    expect(details(1).open).toBe(true);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    fireEvent.click(trigger(0));
    panel(0).querySelector("a")!.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(details(0).open).toBe(false);
    expect(document.activeElement).toBe(trigger(0));
  });

  it("returns focus on Escape when nothing has focus", () => {
    fireEvent.click(trigger(0));
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.activeElement).toBe(trigger(0));
  });

  it("closes on Escape but leaves focus where it is when it's somewhere else", () => {
    fireEvent.click(trigger(0));
    const elsewhere = screen.getByRole("button");
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    expect(details(0).open).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("leaves focus alone on Escape with nothing open", () => {
    screen.getByRole("button").focus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button"));
  });

  it("closes on an outside click, and stays open on a click inside", () => {
    fireEvent.click(trigger(0));
    fireEvent.click(panel(0));
    expect(details(0).open).toBe(true);
    fireEvent.click(screen.getByRole("button"));
    expect(details(0).open).toBe(false);
  });
});

describe("a finding link", () => {
  it("sets the filter to All, and tells the status line", () => {
    render(
      <>
        <ExplainEnhance />
        <div className="chain-filter">
          <label>
            <input type="radio" name="chain" value="all" />
            All
          </label>
          <label>
            <input type="radio" name="chain" value="tempo" defaultChecked />
            Tempo
          </label>
          <p data-chain-status />
        </div>
        <a href="#a-card" data-finding-link>
          A finding
        </a>
      </>,
    );
    const all = screen.getByRole("radio", { name: "All" }) as HTMLInputElement;
    fireEvent.click(screen.getByRole("link"));
    expect(all.checked).toBe(true);
    expect(document.querySelector("[data-chain-status]")!.textContent).toBe("Showing All.");
  });
});
