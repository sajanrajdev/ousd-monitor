import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { loadDataset } from "@/lib/dataset/load";
import { INDEPENDENCE_LINE } from "@/lib/site";
import { at, copySample } from "./dataset-helpers";

const { state } = loadDataset(at(copySample("complete")));

describe("the site shell", () => {
  it("shows the exact independence line in the footer, and keeps the header to the name", () => {
    expect(INDEPENDENCE_LINE).toBe("Independent. Not affiliated with Open Standard or Bridge.");
    render(
      <>
        <SiteHeader />
        <SiteFooter state={state} />
      </>,
    );

    const header = screen.getByRole("banner");
    const footer = screen.getByRole("contentinfo");
    expect(header.textContent).not.toContain(INDEPENDENCE_LINE);
    expect(within(header).queryByRole("link", { name: "Methodology" })).toBeNull();
    expect(within(footer).getByText(INDEPENDENCE_LINE)).toBeTruthy();
    expect(within(footer).getByText(INDEPENDENCE_LINE).closest("details, [data-tip]")).toBeNull();
    expect(within(footer).getByRole("link", { name: "Methodology" }).getAttribute("href")).toMatch(
      /^\/methodology/,
    );
    expect(
      within(header).getByRole("link", { name: "Skip to main content" }).getAttribute("href"),
    ).toBe("#main-content");
  });

  it("says in the footer that it is not financial advice and not an attestation", () => {
    render(<SiteFooter state={state} />);
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
    render(<SiteFooter state={state} repoUrl="" />);
    expect(screen.queryByRole("link", { name: /GitHub/ })).toBeNull();
  });

  it("links to GitHub once the repo URL is set", () => {
    render(<SiteFooter state={state} repoUrl="https://example.invalid/repo" />);
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
        <SiteFooter state={state} repoUrl="https://example.invalid/repo" />
      </>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe("the layout", () => {
  it("mounts the explanation enhancer once", () => {
    const layout = readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8");
    expect(layout.match(/<ExplainEnhance \/>/g)).toHaveLength(1);
  });
});

describe("touch targets", () => {
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

  it("sets a 24px minimum on links that stand alone, and not on links inside a sentence", () => {
    const rule = /([^{}]*)\{[^}]*min-height:\s*1\.5rem[^}]*\}/.exec(css)!;
    expect(rule).not.toBeNull();
    for (const selector of [".target-link"]) {
      expect(rule[1]).toContain(selector);
    }
    expect(rule[1]).not.toMatch(/(^|,)\s*(main\s+)?p\s+a\b/);
  });

  it.each([".tip__icon", ".data-toggle > summary"])("gives %s at least 24px", (selector) => {
    const escaped = selector.replace(/[.>]/g, "\\$&");
    const rule = new RegExp(`${escaped} \\{([^}]*)\\}`).exec(css)!;
    expect(rule).not.toBeNull();
    const sizes = [...rule[1].matchAll(/(?:min-)?height:\s*([\d.]+)rem/g)].map((match) =>
      Number(match[1]),
    );
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(1.5);
  });

  it("puts target-link on the header's own links", () => {
    render(<SiteHeader />);
    expect(screen.getByRole("link", { name: /Open USD Monitor/ }).className).toContain(
      "target-link",
    );
  });
});
