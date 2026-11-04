import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import RootLayout, { generateMetadata } from "@/app/layout";
import Methodology from "@/app/methodology/page";
import Home from "@/app/page";
import { TableCard } from "@/components/chart-card";
import { StatusChip } from "@/components/status-chip";
import { DEFINITION_ANCHORS } from "@/lib/definitions";
import { copySample, editJson, releaseGrade } from "./dataset-helpers";

const SECTIONS = ["verdict", "kpi-row", "trust-strip", "view-a", "view-b", "view-e"];

function useSample(name: "complete" | "partial") {
  vi.stubEnv("OUSD_DATASET_DIR", `fixtures/dataset/${name}`);
}

function layoutDocument(): Document {
  const html = renderToStaticMarkup(RootLayout({ children: <main>Page</main> }) as ReactElement);
  return new DOMParser().parseFromString(html, "text/html");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the main page", () => {
  it("renders every part in order, with each stub", () => {
    useSample("complete");
    const { container } = render(<Home />);
    const order = [...container.querySelectorAll("[data-section]")]
      .map((element) => element.getAttribute("data-section"))
      .filter((name) => name !== "question");
    expect(order).toEqual(SECTIONS);
    const question = container.querySelector('[data-section="question"]')!;
    expect(question.textContent).toContain("Is that turning into money that moves?");
    expect(container.querySelector('[data-section="verdict"]')!.contains(question)).toBe(true);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Not enough data yet");
  });

  it("has the fixed anchors", () => {
    useSample("complete");
    const { container } = render(<Home />);
    for (const id of ["supply-journey", "real-activity", "chain-roles-view"]) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("has a word on every card and in the KPI row, and hatching on every card", () => {
    useSample("complete");
    const { container } = render(<Home />);
    const cards = [...container.querySelectorAll(".chart-card")];
    for (const view of ["view-a", "view-b", "view-e"]) {
      expect(container.querySelector(`[data-section="${view}"] .chart-card`)).not.toBeNull();
    }
    for (const card of cards) {
      expect(card.getAttribute("data-frame")).toBe("Sample");
      expect(card.querySelector(".chart-card__meta")!.textContent).toContain("Sample");
    }
    const kpis = container.querySelector('[data-section="kpi-row"]')!;
    expect(within(kpis as HTMLElement).getByText("Sample")).toBeTruthy();
  });

  it('says "Sample, not a finding" and "Not reconciled"', () => {
    useSample("complete");
    const { container } = render(<Home />);
    expect(screen.getByText("Sample, not a finding")).toBeTruthy();
    expect(container.textContent).not.toContain("Our reading");
    expect(container.querySelector('[data-section="trust-strip"]')!.textContent).toContain(
      "Not reconciled",
    );
    expect(container.textContent).not.toContain("Supply reconciled on all 4 chains");
  });
});

describe("the layout", () => {
  it("frames a sample, with the banner under the header", () => {
    useSample("complete");
    const document = layoutDocument();
    const root = document.documentElement;
    expect(root.dataset.datasetKind).toBe("sample");
    expect(root.dataset.frame).toBe("Sample");
    const banner = document.querySelector("[data-dataset-banner]")!;
    expect(banner.textContent).toContain("Sample data. Nothing here is real.");
    const header = document.querySelector("header")!;
    expect(header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.querySelector("button")).toBeNull();
  });

  it("shows the partial sample's chain and check counts", () => {
    useSample("partial");
    const banner = layoutDocument().querySelector("[data-dataset-banner]")!;
    expect(banner.textContent).toContain("Sample data. Nothing here is real.");
    expect(banner.textContent).toContain("2 of 4 chains, 2 checks not passed.");
  });

  it("marks the title and asks not to be indexed", () => {
    useSample("complete");
    const metadata = generateMetadata();
    expect(metadata.title).toMatchObject({
      default: "[Sample] Open USD Monitor",
      template: "[Sample] %s | Open USD Monitor",
    });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("keeps the independence line in the header and footer", () => {
    useSample("complete");
    const document = layoutDocument();
    const line = "Independent. Not affiliated with Open Standard or Bridge.";
    expect(document.querySelector("header")!.textContent).toContain(line);
    expect(document.querySelector("footer")!.textContent).toContain(line);
  });

  it("gives outbound footer links the rel the output check requires", () => {
    useSample("complete");
    const outbound = [...layoutDocument().querySelectorAll('a[href^="https://"]')];
    expect(outbound.length).toBeGreaterThan(0);
    for (const link of outbound) expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("a real dataset", () => {
  it("has no frame, no banner, no noindex and no mark in the title", () => {
    vi.stubEnv("OUSD_DATASET_DIR", releaseGrade());
    const document = layoutDocument();
    const root = document.documentElement;
    expect(root.dataset.datasetKind).toBe("real");
    expect(root.dataset.frame).toBeUndefined();
    expect(root.dataset.freshness).toMatch(/^(fresh|stale)$/);
    expect(document.querySelector("[data-dataset-banner]")).toBeNull();
    const metadata = generateMetadata();
    expect(metadata.robots).toBeUndefined();
    expect(metadata.title).toMatchObject({ default: "Open USD Monitor" });
  });

  it("has no word on its cards, and no not-a-finding chip", () => {
    vi.stubEnv("OUSD_DATASET_DIR", releaseGrade());
    const { container } = render(<Home />);
    for (const card of container.querySelectorAll(".chart-card")) {
      expect(card.getAttribute("data-frame")).toBeNull();
      expect(card.querySelector(".chart-card__meta")!.textContent).not.toContain("Sample");
    }
    expect(screen.getByText("Our reading")).toBeTruthy();
    expect(container.textContent).not.toContain("Not reconciled");
  });
});

describe("the stale note on every page", () => {
  function stale() {
    const dir = releaseGrade();
    editJson(dir, "manifest.json", (manifest) => {
      manifest.stale = true;
      manifest.stale_since = "2026-11-04T07:00:00Z";
      manifest.stale_reason = "a check failed";
    });
    vi.stubEnv("OUSD_DATASET_DIR", dir);
  }

  it("comes from the layout, so the methodology page and 404 have it", () => {
    stale();
    const document = layoutDocument();
    const note = document.querySelector("[data-stale-note]")!;
    expect(note.textContent).toContain("A newer run did not pass its checks.");
    expect(note.textContent).toContain("Data from 4 Nov 2026, 06:00 UTC.");
    expect(note.textContent).not.toContain("a check failed");
    expect(document.documentElement.dataset.freshness).toBe("stale");
    const header = document.querySelector("header")!;
    expect(header.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is in the page on a fresh dataset too, for the clock to reveal", () => {
    vi.stubEnv("OUSD_DATASET_DIR", "fixtures/dataset/complete");
    const note = layoutDocument().querySelector("[data-stale-note]")!;
    expect(note.textContent).toContain("Nothing newer has reached this page");
  });

  it("is hidden while fresh without giving up its space, and on the main page's own line", () => {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toContain('html[data-freshness="fresh"] .freshness-text__stale');
    expect(css).toMatch(/body:has\(\[data-section="verdict"\]\) \.stale-note\s*\{\s*display: none/);
  });
});

describe("a preview dataset", () => {
  function preview() {
    const dir = copySample("partial");
    rmSync(join(dir, "FIXTURE"));
    editJson(dir, "manifest.json", (manifest) => {
      manifest.git_commit = "abc1234";
    });
    vi.stubEnv("OUSD_DATASET_DIR", dir);
  }

  it("has the preview banner and title, with the counts", () => {
    preview();
    const banner = layoutDocument().querySelector("[data-dataset-banner]")!;
    expect(banner.textContent).toContain("Local preview. Not the published site.");
    expect(banner.textContent).toContain("2 of 4 chains, 2 checks not passed.");
    expect(generateMetadata().title).toMatchObject({ default: "[Preview] Open USD Monitor" });
    expect(generateMetadata().robots).toEqual({ index: false, follow: false });
  });

  it("has Preview on every card, and says not reconciled", () => {
    preview();
    const { container } = render(<Home />);
    for (const card of container.querySelectorAll(".chart-card")) {
      expect(card.getAttribute("data-frame")).toBe("Preview");
      expect(card.querySelector(".chart-card__meta")!.textContent).toContain("Preview");
    }
    expect(screen.getByText("Preview, not a finding")).toBeTruthy();
    expect(container.querySelector('[data-section="trust-strip"]')!.textContent).toContain(
      "Not reconciled",
    );
  });
});

describe("the methodology page", () => {
  it("exists, as a stub unit 3.4 fills in", () => {
    render(<Methodology />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Methodology");
  });
});

describe("shared parts", () => {
  it("the frame CSS has no switch to turn it off", () => {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toContain("html[data-frame] body::before");
    expect(css).toContain(".chart-card[data-frame]::before");
    expect(css).not.toMatch(/\[data-frame\][^{]*\{[^}]*display:\s*none/);
  });

  it("a table card has its parts and no second table", () => {
    const { container } = render(
      <main>
        <TableCard
          takeaway="A takeaway"
          chip="inferred"
          source="A source"
          asOf={{ from: "2026-11-02", to: "2026-11-03" }}
          definitionHref="/methodology/#chain-roles"
          frameWord="Preview"
          summary="A summary"
          table={{
            caption: "A caption",
            columns: [{ key: "chain", label: "Chain" }],
            rows: [{ chain: "Tempo" }],
          }}
        />
      </main>,
    );
    expect(container.querySelectorAll("table").length).toBe(1);
    expect(container.querySelector(".chart-area")).toBeNull();
    const meta = container.querySelector(".chart-card__meta")!.textContent;
    expect(meta).toContain("2 Nov 2026 to 3 Nov 2026 UTC");
    expect(meta).toContain("Preview");
  });

  it("an opinion chip reads as an opinion only on real data", () => {
    const { rerender } = render(<StatusChip kind="opinion" frameWord={null} />);
    expect(screen.getByText("Our reading")).toBeTruthy();
    rerender(<StatusChip kind="opinion" frameWord="Preview" />);
    expect(screen.getByText("Preview, not a finding")).toBeTruthy();
    rerender(<StatusChip kind="fact" frameWord="Preview" />);
    expect(screen.getByText("Fact")).toBeTruthy();
  });

  it("every fixed anchor is listed once", () => {
    expect(new Set(DEFINITION_ANCHORS).size).toBe(23);
  });
});
