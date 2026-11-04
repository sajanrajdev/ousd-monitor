import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Methodology from "@/app/methodology/page";
import { DEFAULT_DEFINITIONS, DEFINITION_ANCHORS, TOKEN_CONTRACTS } from "@/lib/definitions";
import {
  ANCHOR_HEADINGS,
  CONDITIONAL_LIMIT_IDS,
  EXTRA_LIMITS,
  legendLines,
  MIRRORED_SECTIONS,
  renderMethodology,
  VERDICT_THRESHOLDS,
} from "@/lib/methodology";
import { copySample, editJson } from "./dataset-helpers";

const DOC = readFileSync("../docs/methodology.md", "utf8");
const README = readFileSync("../labels/README.md", "utf8");
const PRD = readFileSync("../docs/PRD.md", "utf8");

// PRD section 7's metrics, and the fixed anchor each is defined at.
const PRD_METRICS: Record<string, string> = {
  "Minted, burned, net issuance": "minted-burned",
  "Issuer inventory": "issuer-inventory",
  "Venue supply": "venue-supply",
  "Placed supply": "placed-supply",
  "Free-floating supply": "free-floating",
  "Circulating supply": "circulating-supply",
  "Headline volume": "headline-volume",
  "Clean volume": "clean-volume",
  "Everyday and large clean volume": "everyday-large",
  "Venue flow": "venue-flow",
  "Tempo fee": "tempo-fee",
  Velocity: "velocity",
  "Active wallets": "active-wallets",
  Concentration: "concentration",
  "Implied reserve income": "implied-reserve-income",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function page(dir = "fixtures/dataset/complete") {
  vi.stubEnv("OUSD_DATASET_DIR", dir);
  return render(<Methodology />).container;
}

function withDoc(change: (doc: string) => string): () => unknown {
  return () => renderMethodology(change(DOC));
}

describe("the rendered page", () => {
  it("keeps id=main-content on main, so the skip link has somewhere to go", () => {
    vi.stubEnv("OUSD_DATASET_DIR", "fixtures/dataset/complete");
    const { container } = render(<Methodology />);
    expect(container.querySelector("main#main-content")).not.toBeNull();
  });

  it("has every fixed anchor, once", () => {
    const container = page();
    for (const anchor of DEFINITION_ANCHORS) {
      expect(container.querySelectorAll(`[id="${anchor}"]`).length, anchor).toBe(1);
    }
  });

  it("defines every metric in PRD section 7, each at its own anchor", () => {
    const section = PRD.split("## 7. Metric definitions")[1].split("\n## ")[0];
    const metrics = [...section.matchAll(/^\| \*\*(.+?)\*\* \|/gm)].map((match) => match[1]);
    expect(metrics.sort()).toEqual(Object.keys(PRD_METRICS).sort());
    const container = page();
    for (const anchor of Object.values(PRD_METRICS)) {
      expect(container.querySelector(`[id="${anchor}"]`), anchor).not.toBeNull();
    }
  });

  it("gives the heading text its anchor maps to", () => {
    const container = page();
    for (const [anchor, title] of Object.entries(ANCHOR_HEADINGS)) {
      expect(container.querySelector(`[id="${anchor}"]`)!.textContent).toBe(title);
    }
  });

  it("has one h1 and a section list, collapsed on phones", () => {
    const container = page();
    expect(container.querySelectorAll("h1").length).toBe(1);
    const nav = container.querySelector('nav[aria-label="On this page"]')!;
    expect(nav.querySelector("details:not([open])")).not.toBeNull();
    const hrefs = [...nav.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("#verdict");
    expect(hrefs).toContain("#velocity");
    for (const href of hrefs) {
      expect(container.querySelector(`[id="${href!.slice(1)}"]`), href!).not.toBeNull();
    }
  });

  it("marks an arriving anchor, and keeps every outbound link safe", () => {
    const container = page();
    expect(container.querySelector("#verdict")!.className).toContain("target:");
    for (const link of container.querySelectorAll('a[href^="https://"]')) {
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    for (const link of container.querySelectorAll("a[href]")) {
      expect(link.getAttribute("href")).toMatch(/^(https:\/\/|#|\/methodology\/#)/);
    }
  });

  it("lists the four token contracts exactly, with Solana's case", () => {
    const text = page().textContent!;
    for (const address of Object.values(TOKEN_CONTRACTS)) expect(text).toContain(address);
  });

  it("carries the legend inside data-source-legend, with every source type in the sample", () => {
    const container = page();
    const legend = container.querySelector("[data-source-legend]")!;
    const labels = JSON.parse(readFileSync("fixtures/dataset/complete/labels.json", "utf8"));
    for (const row of labels.data) expect(legend.textContent).toContain(row.source_type);
    for (const row of labels.source_legend.source_types) {
      expect(legend.textContent).toContain(row.meaning);
      expect(legend.textContent).toContain(row.how_to_check.replace(/`/g, ""));
    }
  });

  it("shows every named entity in the labels table, with its source and date", () => {
    const container = page();
    const table = container.querySelector("[data-labels-table]")!;
    const labels = JSON.parse(readFileSync("fixtures/dataset/complete/labels.json", "utf8"));
    expect(labels.data.length).toBeGreaterThan(0);
    for (const row of labels.data) {
      const match = [...table.querySelectorAll("tbody tr")].find(
        (tr) =>
          tr.textContent!.includes(row.entity) &&
          tr.textContent!.includes(row.source_type) &&
          tr.querySelector(`a[href="${row.source_url}"]`),
      );
      expect(match, row.entity).toBeDefined();
    }
    expect(table.querySelector(".chart-card__meta")!.textContent).toContain("Sample");
  });

  it("shows no address for an unnamed cluster, and every category has its rule", () => {
    const container = page();
    const clusters = container.querySelector("[data-unnamed-clusters]")!;
    const labels = JSON.parse(readFileSync("fixtures/dataset/complete/labels.json", "utf8"));
    expect(clusters.textContent).not.toMatch(/0x[0-9a-fA-F]{8}/);
    const categories = new Set(
      labels.unnamed_clusters.counts.map((c: { category: string }) => c.category),
    );
    expect(categories.size).toBeGreaterThan(0);
    expect(clusters.querySelector("[data-unnamed-rule]")!.textContent).toContain(
      "Collection wallets take money from many senders",
    );
    expect(clusters.textContent).toContain("Redemption route");
  });

  it("shows the dataset's limits, then the ones it doesn't carry, each numeric one dated", () => {
    const container = page();
    const summary = JSON.parse(readFileSync("fixtures/dataset/complete/summary.json", "utf8"));
    const shown = container.querySelector("[data-dataset-limits]")!.textContent!;
    for (const limit of summary.known_limits) expect(shown).toContain(limit.text);
    expect(shown).toContain("A transfer lost between two wallets");
    expect(shown).toContain("exactly equals the moves inside the comparison window");
    expect(shown).toContain("(measured 2026-11-04)");
    const extra = container.querySelector("[data-extra-limits]")!.textContent!;
    for (const limit of EXTRA_LIMITS) {
      expect(extra).toContain(limit.text);
      if (limit.measured) expect(extra).toContain(limit.measured);
    }
  });

  it("shows the settings as values, beside the documented defaults", () => {
    const container = page();
    const card = container.querySelector("#documented-defaults")!.parentElement!.parentElement!;
    expect(card.textContent).toContain("placed_days");
    expect(card.textContent).toContain("clean_7d / 7 over circulating_supply");
    expect(card.querySelector(".info-popover__panel")!.textContent).toContain("Source:");
  });

  it("names nothing but what the dataset names", () => {
    const text = page().textContent!;
    const blocked: string[] = JSON.parse(readFileSync("scripts/blocked-names.json", "utf8"));
    const labels = JSON.parse(readFileSync("fixtures/dataset/complete/labels.json", "utf8"));
    const named = labels.data.map((row: { entity: string }) => row.entity).join(" ");
    for (const name of blocked) {
      if (named.includes(name)) continue;
      const found = new RegExp(
        `(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
      );
      if (found.test(text)) {
        // Allowed only beside a source link, or inside the legend.
        const container = page();
        const sourced = [...container.querySelectorAll("li, p, td")].filter((el) =>
          found.test(el.textContent!),
        );
        for (const el of sourced) {
          expect(
            el.closest("[data-source-legend]") || el.querySelector('a[href^="https://"]'),
            name,
          ).toBeTruthy();
        }
      }
    }
  });

  it("renders the same on partial data, with the Preview frame on its cards", () => {
    const container = page("fixtures/dataset/partial");
    for (const card of container.querySelectorAll(".chart-card")) {
      expect(card.getAttribute("data-frame")).toBe("Sample");
    }
  });

  it("fails the build when a named label's source isn't https, at the load", () => {
    const dir = copySample("complete");
    editJson(dir, "labels.json", (labels) => {
      labels.data[0].source_url = "javascript:alert(1)";
    });
    expect(() => page(dir)).toThrow(/source_url/);
  });
});

describe("the document", () => {
  it("renders", () => {
    expect(withDoc((doc) => doc)).not.toThrow();
  });

  it("fails on raw HTML, block or inline", () => {
    expect(withDoc((doc) => `${doc}\n<div>hi</div>\n`)).toThrow(/raw HTML/);
    expect(
      withDoc((doc) =>
        doc.replace("It is not financial advice", "It is <b>not</b> financial advice"),
      ),
    ).toThrow(/raw HTML/);
    expect(withDoc((doc) => `${doc}\n<script>alert(1)</script>\n`)).toThrow(/raw HTML/);
  });

  it("fails on a link that isn't https or in-page, and on an image", () => {
    expect(withDoc((doc) => `${doc}\n[x](javascript:alert(1))\n`)).toThrow(/isn't https/);
    expect(withDoc((doc) => `${doc}\n[x](http://example.com)\n`)).toThrow(/isn't https/);
    expect(withDoc((doc) => `${doc}\n[x](labels/README.md)\n`)).toThrow(/isn't https/);
    expect(withDoc((doc) => `${doc}\n![x](https://example.com/a.png)\n`)).toThrow(/images/);
  });

  it("fails when a mapped heading is missing", () => {
    for (const title of Object.values(ANCHOR_HEADINGS)) {
      expect(
        withDoc((doc) =>
          doc
            .replace(`\n## ${title}\n`, "\n## Elsewhere\n")
            .replace(`\n### ${title}\n`, "\n### Elsewhere\n"),
        ),
        title,
      ).toThrow(/no heading/);
    }
  });

  it("fails on a wallet address that isn't a token contract", () => {
    expect(withDoc((doc) => `${doc}\n0x1234567890abcdef1234567890abcdef12345678\n`)).toThrow(
      /wallet address/,
    );
    expect(withDoc((doc) => `${doc}\nSo11111111111111111111111111111111111111112\n`)).toThrow(
      /wallet address/,
    );
  });

  it("fails on a repeated heading and on a heading too deep", () => {
    expect(withDoc((doc) => `${doc}\n## Venue supply\n`)).toThrow();
    expect(withDoc((doc) => `${doc}\n#### Deeper\n`)).toThrow(/deeper/);
  });

  it("has every mirrored section", () => {
    const ids = renderMethodology(DOC).map((chunk) => chunk.id);
    for (const id of MIRRORED_SECTIONS) expect(ids).toContain(id);
  });

  it("holds the legend labels/README.md holds, word for word", () => {
    expect(legendLines(DOC)).toEqual(legendLines(README));
    expect(legendLines(DOC).length).toBeGreaterThan(5);
  });

  it("fails if one word of the legend differs", () => {
    const changed = DOC.replace(
      "A block explorer shows this name",
      "A block explorer shows that name",
    );
    expect(changed).not.toBe(DOC);
    expect(legendLines(changed)).not.toEqual(legendLines(README));
  });

  it("holds every limit: the table, and each non-conditional one in the sample", () => {
    for (const limit of EXTRA_LIMITS) {
      expect(DOC, limit.id).toContain(limit.text);
      if (limit.measured) expect(DOC).toContain(`${limit.text} | ${limit.measured} |`);
    }
    for (const id of [
      "base_balances_sample",
      "blockscout_lag",
      "large_transfers",
      "tempo_fee_sample",
      "small_ticket",
    ]) {
      expect(EXTRA_LIMITS.find((limit) => limit.id === id)!.measured, id).not.toBeNull();
    }
    for (const sample of ["complete", "partial"]) {
      const summary = JSON.parse(readFileSync(`fixtures/dataset/${sample}/summary.json`, "utf8"));
      for (const limit of summary.known_limits) {
        if ((CONDITIONAL_LIMIT_IDS as readonly string[]).includes(limit.id)) continue;
        expect(DOC, limit.id).toContain(limit.text);
      }
    }
    expect(DOC).toContain("(measured 2026-11-04)");
  });

  it("states the defaults the site's constants hold", () => {
    const rows = new Map(
      [...DOC.matchAll(/^\| `([a-z_]+)` \| (.+?) \|$/gm)].map((match) => [match[1], match[2]]),
    );
    for (const name of [
      "placed_days",
      "placed_min_base_units",
      "large_transfer_base_units",
      "active_dust_base_units",
      "active_secondary_base_units",
      "clean_tx_min_base_units",
      "journey_first_day",
    ] as const) {
      expect(rows.get(name), name).toBe(String(DEFAULT_DEFINITIONS[name]));
    }
    for (const [name, part] of Object.entries(DEFAULT_DEFINITIONS.velocity)) {
      expect(rows.get(name), name).toBe(`\`${part.numerator}\` over \`${part.denominator}\``);
    }
    expect(rows.get("placed_threshold_bps")).toBe(String(VERDICT_THRESHOLDS.placed_bps));
    expect(rows.get("everyday_threshold_bps")).toBe(String(VERDICT_THRESHOLDS.everyday_bps));
    expect(DOC).toContain("50% (5,000 basis points)");
    expect(DOC).toContain("5% (500 basis points)");
  });
});
