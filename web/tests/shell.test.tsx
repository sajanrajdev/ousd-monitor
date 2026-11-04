import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { INDEPENDENCE_LINE } from "@/lib/site";

describe("the site shell", () => {
  it("shows the exact independence line in the header and the footer", () => {
    expect(INDEPENDENCE_LINE).toBe("Independent. Not affiliated with Open Standard or Bridge.");
    render(
      <>
        <SiteHeader />
        <SiteFooter />
      </>,
    );

    const header = screen.getByRole("banner");
    const footer = screen.getByRole("contentinfo");
    expect(within(header).getByText(INDEPENDENCE_LINE)).toBeTruthy();
    expect(within(footer).getByText(INDEPENDENCE_LINE)).toBeTruthy();
  });

  it("says in the footer that it is not financial advice and not an attestation", () => {
    render(<SiteFooter />);
    const footer = screen.getByRole("contentinfo");

    expect(within(footer).getByText("Not financial advice.")).toBeTruthy();
    expect(footer.textContent).toContain("Not an attestation");
    expect(
      within(footer)
        .getByRole("link", { name: /Bridge/ })
        .getAttribute("href"),
    ).toMatch(/^https:\/\/apidocs\.bridge\.xyz\//);
  });

  it("leaves the GitHub link out while the repo URL is empty", () => {
    render(<SiteFooter repoUrl="" />);
    expect(screen.queryByRole("link", { name: /GitHub/ })).toBeNull();
  });

  it("links to GitHub once the repo URL is set", () => {
    render(<SiteFooter repoUrl="https://example.invalid/repo" />);
    expect(screen.getByRole("link", { name: /GitHub/ }).getAttribute("href")).toBe(
      "https://example.invalid/repo",
    );
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <>
        <SiteHeader />
        <main>
          <h1>Page</h1>
        </main>
        <SiteFooter repoUrl="https://example.invalid/repo" />
      </>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
