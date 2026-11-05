import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import RootLayout, { generateMetadata } from "@/app/layout";
import Methodology from "@/app/methodology/page";
import Reconciliation from "@/app/reconciliation/page";
import Home from "@/app/page";
import { TableCard } from "@/components/chart-card";
import { CARD_ANCHORS, DEFINITION_ANCHORS } from "@/lib/definitions";
import { copySample, editJson, releaseGrade } from "./dataset-helpers";

const SECTIONS = [
  "trust-strip",
  "verdict",
  "kpi-row",
  "chain-filter",
  "view-a",
  "view-b",
  "view-e",
];

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
    // The second review removed the question line, to give the header room.
    expect(container.querySelector('[data-section="question"]')).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "At least half of Open USD (OUSD) supply is sitting still.",
    );
  });

  it("has the fixed anchors", () => {
    useSample("complete");
    const { container } = render(<Home />);
    for (const id of ["supply-journey", "real-activity", "chain-roles-view"]) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("has every card's anchor on a card, once", () => {
    useSample("complete");
    const { container } = render(<Home />);
    for (const id of Object.values(CARD_ANCHORS)) {
      const target = container.querySelectorAll(`[id="${id}"]`);
      expect(target).toHaveLength(1);
      // Under a filter the anchor is on the box that's always shown, and each panel holds a card.
      expect(target[0].matches(".chart-card, .chain-panels:has(.chart-card)")).toBe(true);
    }
  });

  it("holds the filter and the three views in the dashboard, each view a card grid", () => {
    useSample("complete");
    const { container } = render(<Home />);
    const dashboard = container.querySelector(".dashboard")!;
    expect(dashboard.firstElementChild!.getAttribute("data-section")).toBe("chain-filter");
    for (const view of ["view-a", "view-b", "view-e"]) {
      const section = container.querySelector(`[data-section="${view}"]`)!;
      expect(section.parentElement).toBe(dashboard);
      expect(section.classList.contains("card-grid")).toBe(true);
    }
  });

  it("lists only the chains in the dataset, with All covered on partial data", () => {
    useSample("partial");
    const { container } = render(<Home />);
    const labels = [...container.querySelectorAll(".chain-filter label")].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["All covered", "Tempo", "Ethereum"]);
    // The supply card shows every chain at once, so only the step line has panels.
    expect(container.querySelectorAll('[data-section="view-a"] [data-chain-panel]')).toHaveLength(
      3,
    );
    const rows = [...container.querySelectorAll("[data-supply-row]")].map(
      (row) => row.querySelector(".supply-row__name")!.textContent,
    );
    expect(rows).toEqual(["All covered", "Tempo", "Ethereum"]);
  });

  it("has no findings row: each finding is its card's heading, in view", () => {
    useSample("complete");
    const { container } = render(<Home />);
    expect(container.querySelector('[data-section="findings"], [data-finding-link]')).toBeNull();
    for (const card of container.querySelectorAll(".chart-card")) {
      expect(
        card.querySelector(".chart-card__head h2")!.textContent!.trim().length,
      ).toBeGreaterThan(0);
    }
  });

  it("puts the trust status first on a sample, and the KPI row last, ahead of every card", () => {
    useSample("complete");
    const { container } = render(<Home />);
    const screen = container.querySelector(".first-screen")!;
    expect(screen.firstElementChild!.getAttribute("data-section")).toBe("trust-strip");
    expect(screen.lastElementChild!.getAttribute("data-section")).toBe("kpi-row");
    expect(screen.querySelector(".chart-card")).toBeNull();
  });

  it("has no marker or marker legend anywhere", () => {
    useSample("complete");
    const { container } = render(<Home />);
    expect(container.querySelector(".status-chip, [data-section='marker-legend']")).toBeNull();
    expect(container.querySelector("details[name], .info-popover")).toBeNull();
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

  it('says "Sample, not a finding." in plain words, and "Not reconciled"', () => {
    useSample("complete");
    const { container } = render(<Home />);
    const frame = screen.getByText("Sample, not a finding.");
    expect(frame.closest("[data-verdict-frame]")).not.toBeNull();
    expect(frame.closest(".tip__panel, details")).toBeNull();
    expect(container.querySelector('[data-section="verdict"]')!.textContent).not.toContain(
      "Our reading",
    );
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

  it("keeps the independence line in the footer, and the header to the name", () => {
    useSample("complete");
    const document = layoutDocument();
    const line = "Independent. Not affiliated with Open Standard or Bridge.";
    expect(document.querySelector("header")!.textContent).not.toContain(line);
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

  it("has no word on its cards, and no reading tag", () => {
    vi.stubEnv("OUSD_DATASET_DIR", releaseGrade());
    const { container } = render(<Home />);
    for (const card of container.querySelectorAll(".chart-card")) {
      expect(card.getAttribute("data-frame")).toBeNull();
      expect(card.querySelector(".chart-card__meta")!.textContent).not.toContain("Sample");
    }
    // "Our reading" is only a group's title, in the reading's tooltip.
    const shown = container.cloneNode(true) as Element;
    shown.querySelectorAll(".tip__panel").forEach((panel) => panel.remove());
    expect(shown.textContent).not.toContain("Our reading");
    expect(container.querySelector("[data-verdict-frame]")).toBeNull();
    expect(container.querySelector(".status-chip")).toBeNull();
    expect(container.textContent).not.toContain("Not reconciled");
  });

  describe("the trust row at the top", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is gone on a build that passed, fresh and reconciled", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-04T08:00:00Z"));
      vi.stubEnv("OUSD_DATASET_DIR", releaseGrade());
      const { container } = render(<Home />);
      expect(container.querySelector('[data-section="trust-strip"]')).toBeNull();
      // The as-of line carries the reconciled time instead, for the reader's clock.
      expect(container.querySelector('[data-section="verdict"]')!.textContent).toContain(
        "Last reconciled",
      );
    });

    it("stays on a real build that's stale, dated and linking to the detail", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-07T08:00:00Z"));
      vi.stubEnv("OUSD_DATASET_DIR", releaseGrade());
      const { container } = render(<Home />);
      const strip = container.querySelector('[data-section="trust-strip"]')!;
      expect(strip.textContent).toContain("Last reconciled");
      expect(strip.querySelector('a[href="/reconciliation/"]')).not.toBeNull();
      expect(strip.querySelector("details")).toBeNull();
    });
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
    expect(screen.getByText("Preview, not a finding.")).toBeTruthy();
    expect(container.querySelector('[data-section="trust-strip"]')!.textContent).toContain(
      "Not reconciled",
    );
  });
});

describe("the reconciliation page", () => {
  it("holds the detail and a way back to the dashboard", () => {
    useSample("complete");
    const { container } = render(<Reconciliation />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Reconciliation");
    const back = screen.getByRole("link", { name: "Back to the dashboard" });
    expect(back.getAttribute("href")).toBe("/");
    const detail = container.querySelector('[data-section="reconciliation"]')!;
    expect(detail.textContent).toContain("It doesn't verify placed share or velocity.");
    expect(detail.textContent).toContain("Not reconciled");
    expect(container.querySelector("details, [data-tip]")).toBeNull();
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

  it("every fixed anchor is listed once", () => {
    expect(new Set(DEFINITION_ANCHORS).size).toBe(24);
  });
});
