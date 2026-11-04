import "server-only";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";

describe("the test setup", () => {
  it("renders a component in the DOM", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Open USD Monitor");
    expect(
      screen.getByText("Independent. Not affiliated with Open Standard or Bridge."),
    ).toBeTruthy();
  });

  it("refuses the network", () => {
    expect(() => fetch("https://example.invalid")).toThrow("a test tried to use the network");
  });
});
