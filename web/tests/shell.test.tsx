import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(
      within(header).getByRole("link", { name: "Skip to main content" }).getAttribute("href"),
    ).toBe("#main-content");
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

describe("touch targets", () => {
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

  it("sets a 24px minimum on links that stand alone, and not on links inside a sentence", () => {
    const rule = /([^{}]*)\{[^}]*min-height:\s*1\.5rem[^}]*\}/.exec(css)!;
    expect(rule).not.toBeNull();
    for (const selector of [".target-link", ".site-header nav a"]) {
      expect(rule[1]).toContain(selector);
    }
    expect(rule[1]).not.toMatch(/(^|,)\s*(main\s+)?p\s+a\b/);
  });

  it("puts target-link on the header's own links", () => {
    render(<SiteHeader />);
    expect(screen.getByRole("link", { name: /Open USD Monitor/ }).className).toContain(
      "target-link",
    );
  });
});
