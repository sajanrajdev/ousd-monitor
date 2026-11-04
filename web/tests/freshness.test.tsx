import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreshnessText, FreshnessWatch } from "@/components/freshness";

const clock = { generatedAt: "2026-11-04T06:00:00Z", freshUntil: "2026-11-05T18:00:00Z" };
const root = document.documentElement;

describe("the freshness watch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    root.dataset.freshness = "fresh";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete root.dataset.freshness;
  });

  it("leaves a fresh page alone", () => {
    vi.setSystemTime("2026-11-05T17:59:00Z");
    render(<FreshnessWatch clock={clock} />);
    expect(root.dataset.freshness).toBe("fresh");
  });

  it("marks the page stale past the limit, on load", () => {
    vi.setSystemTime("2026-11-05T18:01:00Z");
    render(<FreshnessWatch clock={clock} />);
    expect(root.dataset.freshness).toBe("stale");
  });

  it("marks an open page stale as time passes, and never moves back", () => {
    vi.setSystemTime("2026-11-05T17:59:00Z");
    render(<FreshnessWatch clock={clock} />);
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });
    expect(root.dataset.freshness).toBe("stale");

    vi.setSystemTime("2026-11-04T07:00:00Z");
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });
    expect(root.dataset.freshness).toBe("stale");
  });

  it("a dataset stale at build stays stale, even on a clock that reads fresh", () => {
    root.dataset.freshness = "stale";
    vi.setSystemTime("2026-11-04T07:00:00Z");
    render(<FreshnessWatch clock={clock} />);
    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });
    expect(root.dataset.freshness).toBe("stale");
  });

  it("a generated_at ahead of the reader's clock is stale", () => {
    vi.setSystemTime("2026-11-04T05:00:00Z");
    render(<FreshnessWatch clock={clock} />);
    expect(root.dataset.freshness).toBe("stale");
  });
});

describe("the text it switches", () => {
  it("has both texts in the page, in one polite status region", () => {
    render(<FreshnessText fresh="Fresh words" stale="Stale words" />);
    const region = screen.getByRole("status");
    expect(region.textContent).toContain("Fresh words");
    expect(region.textContent).toContain("Stale words");
  });

  it("has no fresh text once a dataset is stale at build", () => {
    render(<FreshnessText fresh={null} stale="Stale words" />);
    expect(screen.getByRole("status").textContent).toBe("Stale words");
  });
});
