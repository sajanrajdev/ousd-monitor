import "server-only";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";

describe("the test setup", () => {
  it("renders a component in the DOM", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "At least half of Open USD (OUSD) supply is sitting still.",
    );
    expect(screen.getByText(/Is that turning into money that moves\?/)).toBeTruthy();
  });

  it("keeps id=main-content on main, so the skip link has somewhere to go", () => {
    const { container } = render(<Home />);
    expect(container.querySelector("main#main-content")).not.toBeNull();
  });

  it("refuses the network", () => {
    expect(() => fetch("https://example.invalid")).toThrow("a test tried to use the network");
  });
});
