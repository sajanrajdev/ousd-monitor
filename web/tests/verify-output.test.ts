import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { locateDataset } from "@/lib/dataset/load";
import { CARD_ANCHORS, TOKEN_CONTRACTS } from "@/lib/definitions";
import { expectedFromDataset, verifyOutput } from "@/scripts/verify-output.mjs";
import { at, copySample, editJson, plantFile, releaseGrade, tempDir } from "./dataset-helpers";
import {
  PLANTED_FINDINGS,
  PLANTED_KPI_SCOPE,
  PLANTED_KPI_VALUES,
  PLANTED_LEGEND,
  PLANTED_TRUST_DETAIL,
  PLANTED_VERDICT,
  type PlantedBand,
  type PlantedRow,
  plantedBands,
  plantedCard,
  plantedExchangeRows,
  plantedFlight,
  plantedRowFlight,
  plantedFindings,
  plantedHeadline,
  plantedKpis,
  plantedNotes,
  plantedNotesFlight,
} from "./planted-first-screen";

const LINE = "Independent. Not affiliated with Open Standard or Bridge.";
const BLOCKED = JSON.parse(readFileSync("scripts/blocked-names.json", "utf8")) as string[];
const CARD = plantedCard("Sample");

const STALE_NOTE = "Data from 4 Nov. Nothing newer has reached this page.";
const STALE_TRUST = "Last reconciled 4 Nov. Nothing newer has reached this page.";
const FRESH_TRUST = "Supply reconciled on all 4 chains as of 4 Nov 2026, 05:30 UTC";

const sampleExpected = {
  kind: "sample",
  frameWord: "Sample",
  version: "20261104T060000Z",
  pipelineStrings: [
    "Sample check detail for chain_supply.",
    'A "quoted" reason, for the serialized case',
  ],
  blockedNames: BLOCKED,
  tokenContracts: TOKEN_CONTRACTS,
  freshness: "stale",
  asOfLine: { fresh: null, stale: STALE_NOTE },
  trustLine: { fresh: "Not reconciled", stale: "Not reconciled" },
  verdict: PLANTED_VERDICT,
  kpiScope: PLANTED_KPI_SCOPE,
  kpiValues: PLANTED_KPI_VALUES,
  findings: PLANTED_FINDINGS,
  essentialNotes: [] as { kind: string; chain?: string; text: string }[],
  exchangeRows: [] as PlantedRow[],
  bands: [] as PlantedBand[],
};

const realExpected = {
  ...sampleExpected,
  kind: "real",
  frameWord: null,
  trustLine: { fresh: null, stale: STALE_TRUST },
  verdict: { ...PLANTED_VERDICT, textVisible: false },
};

const freshRealExpected = {
  ...realExpected,
  freshness: "fresh",
  asOfLine: { fresh: "Data as of 3 Nov 2026 UTC.", stale: STALE_NOTE },
  trustLine: { fresh: FRESH_TRUST, stale: STALE_TRUST },
};

function page(
  body: string,
  attrs = 'data-dataset-kind="sample" data-dataset-version="20261104T060000Z" data-frame="Sample" data-freshness="stale"',
  title = "[Sample] Open USD Monitor",
  head = '<meta name="robots" content="noindex, nofollow"/>',
) {
  return `<!doctype html><html ${attrs}><head><title>${title}</title>${head}</head><body>
    <header><p>${LINE}</p></header>
    <aside data-dataset-banner>Sample data. Nothing here is real.</aside>
    <p data-stale-note>${STALE_NOTE}</p>
    ${plantedFlight([["$", "main", null, {}]])}
    ${body}
    <footer><p>${LINE}</p><p>Not financial advice.</p>
    <a href="https://example.com/r" rel="noopener noreferrer">Reports</a></footer></body></html>`;
}

const MAIN = `<main><section data-section="verdict">${plantedHeadline()}
  <span class="status-chip" data-kind="opinion">Sample, not a finding</span><p>${STALE_NOTE}</p></section>
  <section data-section="kpi-row"><strong>Sample</strong>${plantedKpis()}</section>
  <section data-section="trust-strip">Not reconciled${PLANTED_TRUST_DETAIL}</section>
  ${plantedFindings("Sample")}${PLANTED_LEGEND}${CARD}</main>`;

function site(overrides: { main?: string; methodology?: string; extra?: [string, string][] } = {}) {
  const dir = tempDir();
  plantFile(dir, "index.html", overrides.main ?? page(MAIN));
  plantFile(
    dir,
    "methodology/index.html",
    overrides.methodology ?? page("<main>Methodology</main>"),
  );
  for (const [path, content] of overrides.extra ?? []) plantFile(dir, path, content);
  return dir;
}

function mainWith(body: string) {
  return site({ main: page(`${MAIN}${body}`) });
}

const realAttrs =
  'data-dataset-kind="real" data-dataset-version="20261104T060000Z" data-freshness="stale"';
const REAL_HEADLINE = plantedHeadline(realExpected.verdict);
const REAL_REST = `<section data-section="kpi-row">${plantedKpis()}</section>
  ${plantedFindings(null)}${PLANTED_LEGEND}${plantedCard(null)}`;
const REAL_MAIN = `<main><section data-section="verdict">${REAL_HEADLINE}<p>${STALE_NOTE}</p></section>
  <section data-section="trust-strip">${STALE_TRUST}${PLANTED_TRUST_DETAIL}</section>${REAL_REST}</main>`;
const FRESH_MAIN = `<main><section data-section="verdict">${REAL_HEADLINE}<p>Data as of 3 Nov 2026 UTC.</p><p>${STALE_NOTE}</p></section>
  <section data-section="trust-strip">${FRESH_TRUST} ${STALE_TRUST}${PLANTED_TRUST_DETAIL}</section>${REAL_REST}</main>`;

function realPage(body: string) {
  return page(body, realAttrs, "Open USD Monitor", "").replace(
    "<aside data-dataset-banner>Sample data. Nothing here is real.</aside>",
    "",
  );
}

describe("verifyOutput", () => {
  it("passes a good sample site", () => {
    expect(verifyOutput(site(), sampleExpected)).toEqual([]);
  });

  it("passes a good real site, stale", () => {
    const dir = site({
      main: realPage(REAL_MAIN),
      methodology: realPage("<main>Methodology</main>"),
    });
    expect(verifyOutput(dir, realExpected)).toEqual([]);
  });

  it("passes a good real site, fresh", () => {
    const fresh = (body: string) =>
      realPage(body).replace('data-freshness="stale"', 'data-freshness="fresh"');
    const dir = site({ main: fresh(FRESH_MAIN), methodology: fresh("<main>Methodology</main>") });
    expect(verifyOutput(dir, freshRealExpected)).toEqual([]);
  });

  it("fails when a page is missing", () => {
    const dir = tempDir();
    plantFile(dir, "index.html", page(MAIN));
    expect(verifyOutput(dir, sampleExpected)).toContain("methodology/index.html: missing");
  });

  it("fails with no independence line", () => {
    const html = page(MAIN).replaceAll(LINE, "Something else");
    const problems = verifyOutput(site({ main: html }), sampleExpected);
    expect(problems).toContain("index.html: no independence line in the header");
    expect(problems).toContain("index.html: no independence line in the footer");
  });

  it.each([
    [
      "header",
      (html: string) => html.replace(`<header><p>${LINE}</p></header>`, "<header></header>"),
    ],
    [
      "header",
      (html: string) =>
        html.replace(
          `<header><p>${LINE}</p></header>`,
          `<header><details><summary>More</summary><p>${LINE}</p></details></header>`,
        ),
    ],
    [
      "header",
      (html: string) =>
        html.replace(`<header><p>${LINE}</p></header>`, `<header><p hidden>${LINE}</p></header>`),
    ],
    ["footer", (html: string) => html.replace(`<footer><p>${LINE}</p>`, "<footer>")],
    [
      "footer",
      (html: string) =>
        html.replace(`<footer><p>${LINE}</p>`, `<footer><noscript><p>${LINE}</p></noscript>`),
    ],
    [
      "footer",
      (html: string) =>
        html.replace(`<footer><p>${LINE}</p>`, `<footer><p class="sr-only">${LINE}</p>`),
    ],
  ])("checks the independence line on its own in the %s", (where, change) => {
    const problems = verifyOutput(site({ main: change(page(MAIN)) }), sampleExpected);
    expect(problems).toContain(`index.html: no independence line in the ${where}`);
  });

  it('fails with "not financial advice" only in a details', () => {
    const html = page(MAIN).replace(
      "<p>Not financial advice.</p>",
      "<details><summary>More</summary><p>Not financial advice.</p></details>",
    );
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      'index.html: no "not financial advice"',
    );
  });

  it('fails with no "not financial advice"', () => {
    const html = page(MAIN).replace("Not financial advice.", "");
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      'index.html: no "not financial advice"',
    );
  });

  describe("the frame on sample output", () => {
    it.each([
      ["no banner", (html: string) => html.replace("data-dataset-banner", ""), "no Sample banner"],
      [
        "no title word",
        (html: string) => html.replace("[Sample] ", ""),
        "no [Sample] in the title",
      ],
      ["no noindex", (html: string) => html.replace("noindex, nofollow", ""), "no noindex"],
      [
        "no root frame",
        (html: string) => html.replace(' data-frame="Sample" data-freshness', " data-freshness"),
        "no Sample frame on the page root",
      ],
      [
        "a page root that says real",
        (html: string) => html.replace('data-dataset-kind="sample"', 'data-dataset-kind="real"'),
        "page root says real, dataset is sample",
      ],
      [
        "another dataset's version",
        (html: string) =>
          html.replace('data-dataset-version="20261104T060000Z"', 'data-dataset-version="x"'),
        "built from another dataset version",
      ],
      [
        "a card with no edge",
        (html: string) =>
          html.replace('class="chart-card" data-frame="Sample"', 'class="chart-card"'),
        "a card has no Sample edge",
      ],
      [
        "a card with no word",
        (html: string) => html.replace("· <strong>Sample</strong>", ""),
        'a card has no "Sample" beside its as-of time',
      ],
      [
        "no opinion swap",
        (html: string) => html.replace("Sample, not a finding", "Our reading"),
        'the verdict chip doesn\'t say "Sample, not a finding"',
      ],
      [
        "no word in the KPI row",
        (html: string) =>
          html.replace(
            '<section data-section="kpi-row"><strong>Sample</strong>',
            '<section data-section="kpi-row">',
          ),
        'no "Sample" in the KPI row',
      ],
      [
        "a live trust strip",
        (html: string) => html.replace("Not reconciled", "Reconciled"),
        'the trust strip doesn\'t say "Not reconciled"',
      ],
      [
        "the banner in a details",
        (html: string) =>
          html.replace(
            "<aside data-dataset-banner>Sample data. Nothing here is real.</aside>",
            "<details><summary>More</summary><aside data-dataset-banner>Sample data. Nothing here is real.</aside></details>",
          ),
        "no Sample banner",
      ],
      [
        "an empty banner",
        (html: string) => html.replace("Sample data. Nothing here is real.", ""),
        "no Sample banner",
      ],
      [
        "the verdict chip in a details",
        (html: string) =>
          html.replace(
            '<span class="status-chip" data-kind="opinion">Sample, not a finding</span>',
            '<details><summary>More</summary><span class="status-chip" data-kind="opinion">Sample, not a finding</span></details>',
          ),
        'the verdict chip doesn\'t say "Sample, not a finding"',
      ],
      [
        "the KPI word in a details",
        (html: string) =>
          html.replace(
            '<section data-section="kpi-row"><strong>Sample</strong>',
            '<section data-section="kpi-row"><details><summary>More</summary><strong>Sample</strong></details>',
          ),
        'no "Sample" in the KPI row',
      ],
      [
        "the KPI word in a noscript",
        (html: string) =>
          html.replace(
            '<section data-section="kpi-row"><strong>Sample</strong>',
            '<section data-section="kpi-row"><noscript><strong>Sample</strong></noscript>',
          ),
        'no "Sample" in the KPI row',
      ],
      [
        "the trust strip's words in a details",
        (html: string) =>
          html.replace(
            '<section data-section="trust-strip">Not reconciled',
            '<section data-section="trust-strip"><details><summary>More</summary>Not reconciled</details>',
          ),
        'the trust strip doesn\'t say "Not reconciled"',
      ],
    ])("%s", (_name, change, problem) => {
      const problems = verifyOutput(site({ main: change(page(MAIN)) }), sampleExpected);
      expect(problems).toContain(`index.html: ${problem}`);
    });

    it("no reconciled sentence anywhere, including serialized props", () => {
      const dir = site({ extra: [["index.txt", '{"a":"Supply reconciled on all 4 chains"}']] });
      expect(verifyOutput(dir, sampleExpected)).toContain(
        'index.txt: holds "Supply reconciled on all 4 chains" on non-real data',
      );
    });

    it("real output has no frame", () => {
      const dir = site({
        main: realPage(`${REAL_MAIN}<aside data-dataset-banner>x</aside>`),
        methodology: realPage("<main>Methodology</main>"),
      });
      expect(verifyOutput(dir, realExpected)).toContain(
        "index.html: real data has the non-real frame",
      );
    });
  });

  describe("addresses", () => {
    it("fails on an address that isn't a token contract", () => {
      const problems = verifyOutput(mainWith(`<p>0x${"a1".repeat(20)}</p>`), sampleExpected);
      expect(problems).toContain("index.html: an address in the page");
      expect(problems.join()).not.toContain("a1a1a1");
    });

    it("fails on a base58 address", () => {
      const problems = verifyOutput(
        mainWith("<p>3ZGf3ERiitfTR9RCChchfo7QWmSfH1WArJ3jjrtMXnKa</p>"),
        sampleExpected,
      );
      expect(problems).toContain("index.html: an address in the page");
    });

    it("allows the four token contracts on the methodology page only", () => {
      const list = Object.values(TOKEN_CONTRACTS)
        .map((address) => `<li>${address}</li>`)
        .join("");
      expect(verifyOutput(site({ methodology: page(`<ul>${list}</ul>`) }), sampleExpected)).toEqual(
        [],
      );
      expect(verifyOutput(mainWith(`<ul>${list}</ul>`), sampleExpected)).toContain(
        "index.html: an address in the page",
      );
    });

    it("fails on an address in the title, an attribute or serialized props", () => {
      const address = `0x${"c3".repeat(20)}`;
      const inTitle = page(MAIN, undefined, `[Sample] ${address}`);
      expect(verifyOutput(site({ main: inTitle }), sampleExpected)).toContain(
        "index.html: an address in the page",
      );
      expect(verifyOutput(mainWith(`<p title="${address}">x</p>`), sampleExpected)).toContain(
        "index.html: an address in the page",
      );
      const serialized = site({ extra: [["__next._full.txt", `{"a":"${address}"}`]] });
      expect(verifyOutput(serialized, sampleExpected)).toContain(
        "__next._full.txt: an address in the page",
      );
    });

    it("fails on an address in the methodology page's title, but allows one in a source link", () => {
      const address = `0x${"c3".repeat(20)}`;
      const inTitle = page("<main>M</main>", undefined, `[Sample] ${address}`);
      expect(verifyOutput(site({ methodology: inTitle }), sampleExpected)).toContain(
        "methodology/index.html: an address in the page",
      );
      const inLink = page(
        `<a href="https://example.com/address/${address}" rel="noopener noreferrer">source</a>`,
      );
      expect(verifyOutput(site({ methodology: inLink }), sampleExpected)).toEqual([]);
    });

    it("fails on another address on the methodology page", () => {
      const html = page(`<p>0x${"b2".repeat(20)}</p>`);
      expect(verifyOutput(site({ methodology: html }), sampleExpected)).toContain(
        "methodology/index.html: an address in the page",
      );
    });
  });

  describe("pipeline strings", () => {
    it("fails on a `detail` string in a serialized prop", () => {
      const dir = site({
        extra: [["_next/static/chunks/a.js", 'x="Sample check detail for chain_supply."']],
      });
      expect(verifyOutput(dir, sampleExpected)).toContain(
        "_next/static/chunks/a.js: holds a pipeline string that isn't reader copy",
      );
    });

    it("fails on a `stale_reason` string, escaped as a serialized prop", () => {
      const dir = site({
        extra: [["index.txt", JSON.stringify({ reason: sampleExpected.pipelineStrings[1] })]],
      });
      expect(verifyOutput(dir, sampleExpected)).toContain(
        "index.txt: holds a pipeline string that isn't reader copy",
      );
    });

    it("fails on one rendered with HTML escaping", () => {
      const dir = mainWith("<p>A &quot;quoted&quot; reason, for the serialized case</p>");
      expect(verifyOutput(dir, sampleExpected)).toContain(
        "index.html: holds a pipeline string that isn't reader copy",
      );
    });

    it("reads a file type it has no name for", () => {
      const dir = site({ extra: [["_next/data.rsc", "Sample check detail for chain_supply."]] });
      expect(verifyOutput(dir, sampleExpected)).toContain(
        "_next/data.rsc: holds a pipeline string that isn't reader copy",
      );
    });

    it("fails on an RPC variable's name", () => {
      const dir = site({ extra: [["_next/a.js", "process.env.BASE_RPC_URL"]] });
      expect(verifyOutput(dir, sampleExpected)).toContain(
        "_next/a.js: holds an RPC variable's name",
      );
    });
  });

  describe("names", () => {
    it("fails on a labelled entity's name on the main page", () => {
      expect(verifyOutput(mainWith("<p>Held at Coinbase today</p>"), sampleExpected)).toContain(
        'index.html: names "Coinbase"',
      );
    });

    it("fails on a name in the main page's serialized props", () => {
      const dir = site({ extra: [["__next._full.txt", '{"entity":"Coinbase"}']] });
      expect(verifyOutput(dir, sampleExpected)).toContain('__next._full.txt: names "Coinbase"');
    });

    it("fails on a name that's entity-encoded, or on another page but the methodology", () => {
      expect(verifyOutput(mainWith("<p>Coin&#98;ase</p>"), sampleExpected)).toContain(
        'index.html: names "Coinbase"',
      );
      const dir = site({ extra: [["404.html", page("<p>Coinbase</p>")]] });
      expect(verifyOutput(dir, sampleExpected)).toContain('404.html: names "Coinbase"');
    });

    it("scans a page's serialized props in a nested folder, but not the methodology's", () => {
      const inNotFound = site({ extra: [["_not-found/__next._full.txt", '{"a":"Coinbase"}']] });
      expect(verifyOutput(inNotFound, sampleExpected)).toHaveLength(1);
      const inMethodology = site({ extra: [["methodology/__next._full.txt", '{"a":"Coinbase"}']] });
      expect(verifyOutput(inMethodology, sampleExpected)).toEqual([]);
    });

    it("matches whole words and case, so Coinbase and Base stay distinct", () => {
      expect(BLOCKED).not.toContain("Base");
      expect(verifyOutput(mainWith("<p>On Base and on coinbases</p>"), sampleExpected)).toEqual([]);
    });

    it("allows a name on the methodology page only beside its source", () => {
      const sourced = page(
        '<table data-labels-table><tr><td>Coinbase</td></tr></table><p><a href="https://www.coinbase.com/m" rel="noopener noreferrer">Coinbase</a></p>',
      );
      expect(verifyOutput(site({ methodology: sourced }), sampleExpected)).toEqual([]);
      const legend = page(
        "<section data-source-legend><p>The 0x Settler labels rest on this.</p></section>",
      );
      expect(verifyOutput(site({ methodology: legend }), sampleExpected)).toEqual([]);
      for (const unsourced of [
        "<p>Coinbase holds this.</p>",
        '<p>Coinbase holds the exchange-linked wallets. <a href="https://www.coinbase.com/price/ousd" rel="noopener noreferrer">Its page</a></p>',
        '<p><a href="https://example.com/m" rel="noopener noreferrer">Coinbase</a></p>',
        '<p><a href="https://coinbase.evil.example/m" rel="noopener noreferrer">Coinbase</a></p>',
        '<p><a href="https://notcoinbase.com/m" rel="noopener noreferrer">Coinbase</a></p>',
        '<p><a href="https://www.coinbase.com/m" rel="noopener noreferrer">Coinbase holds the exchange-linked wallets</a></p>',
      ]) {
        expect(verifyOutput(site({ methodology: page(unsourced) }), sampleExpected)).toContain(
          'methodology/index.html: names "Coinbase" with no source beside it',
        );
      }
    });

    it("reads a name however it's written, on the methodology and not-found pages", () => {
      const rows = [
        { entity: "Coinbase", detail: "d", sourceHref: "/methodology/", sourceText: "s" },
      ];
      const named = { ...sampleExpected, exchangeRows: rows };
      const main = page(
        `${MAIN}<ul>${plantedExchangeRows(rows)}</ul>${plantedFlight(rows.map(plantedRowFlight))}`,
      );
      for (const written of [
        "COINBASE holds this",
        "coinbase holds this",
        "Coin<b>base</b> holds this",
        "Coin\u200bbase holds this",
      ]) {
        const methodology = page(`<p>${written}</p>`);
        expect(verifyOutput(site({ main, methodology }), named)).toContain(
          'methodology/index.html: names "Coinbase" with no source beside it',
        );
        const notFound = page(`<p>${written}</p>`);
        expect(verifyOutput(site({ main, extra: [["404.html", notFound]] }), named)).toContain(
          '404.html: names "Coinbase"',
        );
      }
      const allowed = page(
        '<p><a href="https://www.coinbase.com/p" rel="noopener noreferrer">Coinbase</a></p><table data-labels-table><tr><td>coinbase</td></tr></table>',
      );
      expect(verifyOutput(site({ main, methodology: allowed }), named)).toEqual([]);
    });

    it("the list has every entity in labels.csv but the issuer", () => {
      const [header, ...rows] = readFileSync("../labels/labels.csv", "utf8").trim().split("\n");
      const column = header.split(",").indexOf("entity");
      const entities = new Set(rows.map((row) => row.split(",")[column]).filter(Boolean));
      entities.delete("Bridge");
      expect(entities.size).toBeGreaterThan(0);
      for (const entity of entities) expect(BLOCKED).toContain(entity);
    });

    it("the list has every exchange the labels README lists", () => {
      const readme = readFileSync("../labels/README.md", "utf8");
      const listed = [...readme.matchAll(/^\| ([^|`]+?) \| https:\/\/\S+ \| [0-9-]+ \|$/gm)];
      expect(listed.map((row) => row[1])).toEqual(["Coinbase", "Kraken"]);
      for (const row of listed) expect(BLOCKED).toContain(row[1]);
    });

    it("the list leaves out the four chains, Bridge and Open Standard", () => {
      for (const name of ["Tempo", "Ethereum", "Base", "Solana", "Bridge", "Open Standard"]) {
        expect(BLOCKED).not.toContain(name);
      }
    });
  });

  describe("links and requests", () => {
    it.each([
      ["an on* attribute", '<p onclick="x()">x</p>', "an onclick attribute"],
      [
        "a javascript link",
        '<a href="javascript:x()">x</a>',
        "a link that isn't https, mailto or same-site",
      ],
      [
        "an http link",
        '<a href="http://example.com">x</a>',
        "a link that isn't https, mailto or same-site",
      ],
      [
        "a protocol-relative link",
        '<a href="//example.com">x</a>',
        "a link that isn't https, mailto or same-site",
      ],
      [
        "no rel",
        '<a href="https://example.com">x</a>',
        'an outbound link without rel="noopener noreferrer"',
      ],
      [
        "half a rel",
        '<a href="https://example.com" rel="noopener">x</a>',
        'an outbound link without rel="noopener noreferrer"',
      ],
      [
        "another host's script",
        '<script src="https://cdn.example.com/a.js"></script>',
        "a request to another host from <script>",
      ],
      [
        "another host's image",
        '<img src="//cdn.example.com/a.png" alt=""/>',
        "a request to another host from <img>",
      ],
      [
        "another host's stylesheet",
        '<link rel="stylesheet" href="https://cdn.example.com/a.css"/>',
        "a request to another host from <link>",
      ],
    ])("fails on %s", (_name, html, problem) => {
      expect(verifyOutput(mainWith(html), sampleExpected)).toContain(`index.html: ${problem}`);
    });

    it("allows same-site and mailto links, and our own requests", () => {
      const html =
        '<a href="/methodology/">x</a><a href="#a">y</a><a href="mailto:a@example.com">z</a><script src="/_next/a.js"></script>';
      expect(verifyOutput(mainWith(html), sampleExpected)).toEqual([]);
    });

    it("fails on an @import from another host in CSS", () => {
      const dir = site({ extra: [["_next/a.css", '@import "https://example.com/a.css";']] });
      expect(verifyOutput(dir, sampleExpected)).toContain(
        "_next/a.css: a request to another host from CSS",
      );
    });

    it("fails on another host in CSS", () => {
      const dir = site({
        extra: [["_next/a.css", "a{background:url(https://example.com/a.png)}"]],
      });
      expect(verifyOutput(dir, sampleExpected)).toContain(
        "_next/a.css: a request to another host from CSS",
      );
    });
  });

  describe("chart cards", () => {
    const POPOVER_SOURCE = "<p>Source: S</p>";
    const POPOVER_LINK = '<a href="/methodology/#velocity">Definition</a></div>';
    const NOTE = /<noscript>.*<\/noscript>/;
    const NOTE_LINK = ' · <a href="/methodology/#velocity">Definition</a></p></noscript>';
    const TIME = '<time datetime="2026-11-03">3 Nov</time>';

    it.each([
      ["as-of time", (card: string) => card.replace(TIME, ""), "a card has no visible as-of time"],
      [
        "as-of time but in a details",
        (card: string) =>
          card
            .replace(TIME, "")
            .replace("</details>", `<p class="chart-card__meta">${TIME}</p></details>`),
        "a card has no visible as-of time",
      ],
      [
        "as-of time but in a noscript",
        (card: string) =>
          card
            .replace(TIME, "")
            .replace("</noscript>", `<p class="chart-card__meta">${TIME}</p></noscript>`),
        "a card has no visible as-of time",
      ],
      [
        "source in the popover",
        (card: string) => card.replace(POPOVER_SOURCE, ""),
        "a card's popover has no source",
      ],
      [
        "definition link in the popover",
        (card: string) => card.replace(POPOVER_LINK, "</div>"),
        "a card's popover has no definition link",
      ],
      [
        "noscript note, so the source is only in the popover",
        (card: string) => card.replace(NOTE, ""),
        "a card's noscript note has no source",
      ],
      [
        "definition link in the noscript note",
        (card: string) => card.replace(NOTE_LINK, "</p></noscript>"),
        "a card's noscript note has no definition link",
      ],
    ])("fails with no %s", (_name, change, problem) => {
      const html = page(MAIN.replace(CARD, change(CARD)));
      expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
        `index.html: ${problem}`,
      );
    });

    it("a card's frame word doesn't count from inside a details", () => {
      const moved = CARD.replace("<strong>Sample</strong>", "").replace(
        "</details>",
        '<p class="chart-card__meta"><strong>Sample</strong></p></details>',
      );
      const html = page(MAIN.replace(CARD, moved));
      expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
        'index.html: a card has no "Sample" beside its as-of time',
      );
    });

    const HEADING = "<h2>T</h2>";
    const CHIP = '<span class="status-chip" data-kind="fact">F</span>';
    const inPanel = (card: string, part: string) =>
      card.replace(part, "").replace("<p>Source: S</p>", `${part}<p>Source: S</p>`);

    it.each([
      ["deleted", (card: string) => card.replace(HEADING, "")],
      ["empty", (card: string) => card.replace(HEADING, "<h2> </h2>")],
      ["in the popover", (card: string) => inPanel(card, HEADING)],
      ["in a noscript", (card: string) => card.replace(HEADING, `<noscript>${HEADING}</noscript>`)],
      ["hidden", (card: string) => card.replace(HEADING, "<h2 hidden>T</h2>")],
      ["visually hidden", (card: string) => card.replace(HEADING, '<h2 class="sr-only">T</h2>')],
    ])("fails on a takeaway that's %s", (_name, change) => {
      const html = page(MAIN.replace(CARD, change(CARD)));
      expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
        "index.html: a card has no visible takeaway",
      );
    });

    it.each([
      ["deleted", (card: string) => card.replace(CHIP, "")],
      ["empty", (card: string) => card.replace(">F</span>", "></span>")],
      ["in the popover", (card: string) => inPanel(card, CHIP)],
      ["in a noscript", (card: string) => card.replace(CHIP, `<noscript>${CHIP}</noscript>`)],
      [
        "only a word for assistive tech",
        (card: string) => card.replace(">F</span>", '><span class="sr-only">Fact</span></span>'),
      ],
      [
        "outside the head",
        (card: string) => card.replace(CHIP, "").replace("<table>", `${CHIP}<table>`),
      ],
    ])("fails on a marker that's %s", (_name, change) => {
      const html = page(MAIN.replace(CARD, change(CARD)));
      expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
        "index.html: a card has no visible marker",
      );
    });

    it.each([
      [
        "a hidden meta line",
        (card: string) =>
          card.replace('class="chart-card__meta"', 'class="chart-card__meta" hidden'),
        "a card has no visible as-of time",
      ],
      [
        "a visually hidden meta line",
        (card: string) =>
          card.replace('class="chart-card__meta"', 'class="chart-card__meta sr-only"'),
        "a card has no visible as-of time",
      ],
      [
        "a meta line hidden inline",
        (card: string) =>
          card.replace('class="chart-card__meta"', 'class="chart-card__meta" style="display:none"'),
        "a card has no visible as-of time",
      ],
      [
        "an as-of with no text",
        (card: string) => card.replace(">3 Nov</time>", "> </time>"),
        "a card has no visible as-of time",
      ],
      [
        "an as-of with no datetime value",
        (card: string) => card.replace('datetime="2026-11-03"', 'datetime=""'),
        "a card has no visible as-of time",
      ],
      [
        "a popover source with no value",
        (card: string) => card.replace("<p>Source: S</p>", "<p>Source: </p>"),
        "a card's popover has no source",
      ],
      [
        "a noscript source with no value",
        (card: string) => card.replace("Source: S · ", "Source:  · "),
        "a card's noscript note has no source",
      ],
      [
        "a popover link that isn't to the methodology",
        (card: string) =>
          card.replace(
            '<a href="/methodology/#velocity">Definition</a></div>',
            '<a href="#velocity">Definition</a></div>',
          ),
        "a card's popover has no definition link",
      ],
      [
        "a noscript link with no anchor",
        (card: string) =>
          card.replace(
            '<a href="/methodology/#velocity">Definition</a></p></noscript>',
            '<a href="/methodology/">Definition</a></p></noscript>',
          ),
        "a card's noscript note has no definition link",
      ],
      ["no table", (card: string) => card.replace("<table></table>", ""), "a card has no table"],
    ])("fails on %s", (_name, change, problem) => {
      const html = page(MAIN.replace(CARD, change(CARD)));
      expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
        `index.html: ${problem}`,
      );
    });

    describe("a chart that draws only in the browser", () => {
      const PROBLEM = "index.html: a chart that draws only in the browser has no note for it";
      const withPlot = (plot: string) =>
        page(MAIN.replace(CARD, CARD.replace("<table></table>", `<table></table>${plot}`)));
      const NOTE =
        '<noscript><p class="chart-area__needs-js">This chart needs JavaScript.</p></noscript>';

      it.each([
        ["an empty area", '<div><div class="chart-area"></div></div>'],
        [
          "a Recharts container beside its legend",
          '<div><div class="chart-area"><ul><li>Total</li></ul><div class="recharts-responsive-container"></div></div></div>',
        ],
      ])("fails on %s with no note", (_name, plot) => {
        expect(verifyOutput(site({ main: withPlot(plot) }), sampleExpected)).toContain(PROBLEM);
      });

      it("passes with its note, and a hand-built chart needs none", () => {
        const noted = withPlot(`<div><div class="chart-area"></div>${NOTE}</div>`);
        expect(verifyOutput(site({ main: noted }), sampleExpected)).toEqual([]);
        const built = withPlot('<div><div class="chart-area"><ol><li>$1M</li></ol></div></div>');
        expect(verifyOutput(site({ main: built }), sampleExpected)).toEqual([]);
      });
    });

    it.each([
      ["a details", "<details><ol data-pinned-notes><li>A caveat</li></ol></details>"],
      ["a noscript", "<noscript><ol data-pinned-notes><li>A caveat</li></ol></noscript>"],
    ])("fails on pinned notes inside %s", (_name, html) => {
      expect(verifyOutput(mainWith(html), sampleExpected)).toContain(
        "index.html: pinned notes inside a details or noscript",
      );
    });

    it("passes pinned notes in the open", () => {
      const html = "<ol data-pinned-notes><li>A caveat</li></ol>";
      expect(verifyOutput(mainWith(html), sampleExpected)).toEqual([]);
    });
  });
});

describe('"Our reading" outside the verdict chip', () => {
  it("is fine in the verdict's accordion heading, on a framed page", () => {
    const heading = MAIN.replace(
      `<p>${STALE_NOTE}</p></section>`,
      `<p>${STALE_NOTE}</p><h3>Our reading</h3></section>`,
    );
    expect(verifyOutput(site({ main: page(heading) }), sampleExpected)).toEqual([]);
  });

  it("is fine in the methodology page's chip table, on a framed page", () => {
    const table = page(
      "<table><tr><td>Our reading</td><td>An opinion about the facts</td></tr></table>",
    );
    expect(verifyOutput(site({ methodology: table }), sampleExpected)).toEqual([]);
  });

  it("fails when the verdict has no chip at all", () => {
    const html = page(MAIN).replace(
      '<span class="status-chip" data-kind="opinion">Sample, not a finding</span>',
      "<span>Sample, not a finding</span>",
    );
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      'index.html: the verdict chip doesn\'t say "Sample, not a finding"',
    );
  });
});

describe("the first screen", () => {
  const change = (from: string, to: string) => (html: string) => {
    expect(html).toContain(from);
    return html.replaceAll(from, to);
  };
  const inDetails = (inner: string) => `<details><summary>More</summary>${inner}</details>`;
  const finding = /<li><a href="#card"[\s\S]*?<\/a><\/li>/;

  it.each([
    [
      "a headline that isn't the verdict's sentence",
      change("<h1>A headline.</h1>", "<h1>Another headline.</h1>"),
      "the headline isn't the verdict's sentence",
    ],
    [
      "the headline in a details",
      change("<h1>A headline.</h1>", inDetails("<h1>A headline.</h1>")),
      "the headline isn't the verdict's sentence",
    ],
    [
      "no question line",
      change('<p data-section="question">A question?</p>', ""),
      "no question line in view",
    ],
    [
      "verdict.text in a details on a dataset that keeps it in view",
      change(
        "<p data-verdict-text>The verdict's text, 12% &amp; more.</p>",
        inDetails("<p data-verdict-text>The verdict's text, 12% &amp; more.</p>"),
      ),
      "verdict.text isn't in view on this dataset",
    ],
    [
      "verdict.text visually hidden",
      change("<p data-verdict-text>", '<p class="sr-only" data-verdict-text>'),
      "verdict.text isn't in view on this dataset",
    ],
    [
      "verdict.text reworded",
      change("The verdict's text, 12%", "The verdict's text, about 12%"),
      "verdict.text isn't in view on this dataset",
    ],
    [
      "a verdict item lost from the popover",
      change("<li>An estimate.</li>", ""),
      "the headline's popover has lost a verdict item",
    ],
    [
      "no definition link in the headline's popover",
      change('<a href="/methodology/#verdict">How we read this</a>', ""),
      "the headline's popover has no definition link",
    ],
    [
      "a KPI cell gone",
      (html: string) => html.replace(/<dl><div>[\s\S]*?<\/div>/, "<dl>"),
      "the KPI row has 3 cells",
    ],
    [
      "a KPI value in its popover",
      change("<span data-kpi-value>$1</span>", ""),
      "a KPI has no value in view",
    ],
    [
      "a KPI marker that's only a word for assistive tech",
      change(
        '<span aria-hidden="true">F</span><span class="sr-only">Fact</span>',
        '<span class="sr-only">Fact</span>',
      ),
      "a KPI has no marker in view",
    ],
    [
      "a KPI with no note",
      change("<p data-kpi-note>A note.</p>", "<p>As of 3 Nov.</p>"),
      "a KPI's popover has no note",
    ],
    [
      "a KPI with no definition link",
      change(
        '<p data-kpi-note>A note.</p><a href="/methodology/#velocity">Definition</a>',
        "<p data-kpi-note>A note.</p>",
      ),
      "a KPI's popover has no definition link",
    ],
    [
      "a KPI with no plain note",
      change(
        '<noscript><p>A note. <a href="/methodology/#velocity">Definition</a></p></noscript>',
        "",
      ),
      "a KPI's noscript note has no definition link",
    ],
    [
      "the KPI row's chains in a details",
      change("<p>Across Tempo.</p>", inDetails("<p>Across Tempo.</p>")),
      "the KPI row doesn't say which chains it covers",
    ],
    ["a finding gone", (html: string) => html.replace(finding, ""), "there are 3 findings"],
    [
      "a finding's text in a details",
      change(
        '<span class="finding__text">T</span>',
        inDetails('<span class="finding__text">T</span>'),
      ),
      "a finding has no text in view",
    ],
    [
      "a finding's marker gone",
      change(
        '<span class="finding__marks"><span class="status-chip" data-kind="fact">F</span>',
        '<span class="finding__marks">',
      ),
      "a finding has no marker in view",
    ],
    [
      "a finding with a different marker",
      change(
        '<span class="finding__marks"><span class="status-chip" data-kind="fact">',
        '<span class="finding__marks"><span class="status-chip" data-kind="estimate">',
      ),
      "a finding's marker differs from #card",
    ],
    [
      "a finding with no frame word",
      change("</span><strong>Sample</strong></span></a>", "</span></span></a>"),
      'a finding has no "Sample"',
    ],
    [
      "a finding's target gone",
      change('id="card"', 'id="elsewhere"'),
      "a finding links to #card, which isn't on the page",
    ],
    [
      "a finding that differs from its chart's heading",
      change(
        '<span class="finding__text">T</span>',
        '<span class="finding__text">Another finding</span>',
      ),
      "a finding differs from the heading of #card",
    ],
    [
      "the legend gone",
      change("<p>F Fact, I Inferred, E Estimate</p>", ""),
      "the marker legend isn't in view",
    ],
    [
      "the legend in a details",
      change(
        "<p>F Fact, I Inferred, E Estimate</p>",
        inDetails("<p>F Fact, I Inferred, E Estimate</p>"),
      ),
      "the marker legend isn't in view",
    ],
    [
      "no definition link in the legend's popover",
      change('<a href="/methodology/#fact-estimate-opinion">Fact, estimate and opinion</a>', ""),
      "the marker legend's popover has no definition link",
    ],
    [
      "a second disclosure on the trust row",
      change(
        "Reconciliation detail</summary>",
        "Reconciliation detail</summary><details><summary>x</summary></details>",
      ),
      "the trust row has 2 disclosures, not one",
    ],
    [
      "the trust row's caveat lost",
      change("<p>It doesn't verify placed share or velocity.</p>", ""),
      "the trust row's disclosure has lost what it says it doesn't verify",
    ],
    [
      "the trust row's definition link lost",
      change('<a href="/methodology/#reconciliation">What this covers</a>', ""),
      "the trust row's disclosure has no definition link",
    ],
  ])("fails on %s", (_name, mutate, problem) => {
    const problems = verifyOutput(site({ main: mutate(page(MAIN)) }), sampleExpected);
    expect(problems).toContain(`index.html: ${problem}`);
  });

  it("a real, four-chain page keeps verdict.text in its popover, verbatim", () => {
    const moved = realPage(
      REAL_MAIN.replace("The verdict's text, 12%", "The verdict's text, about 12%"),
    );
    const dir = site({ main: moved, methodology: realPage("<main>M</main>") });
    expect(verifyOutput(dir, realExpected)).toContain(
      "index.html: verdict.text is neither in view nor in its popover",
    );
  });

  it("doesn't count text out of its popover as in view on a page that needs it there", () => {
    const stays = { ...realExpected, verdict: { ...PLANTED_VERDICT, textVisible: true } };
    const dir = site({ main: realPage(REAL_MAIN), methodology: realPage("<main>M</main>") });
    expect(verifyOutput(dir, stays)).toContain(
      "index.html: verdict.text isn't in view on this dataset",
    );
  });

  describe("the essential caveats", () => {
    const notes = [
      { kind: "placed", text: "A caveat." },
      { kind: "velocity-warning", chain: "ethereum", text: "A dated warning." },
    ];
    const expected = { ...sampleExpected, essentialNotes: notes };

    it("passes with each in view", () => {
      expect(verifyOutput(mainWith(plantedNotes(notes)), expected)).toEqual([]);
    });

    it.each([
      ["gone", () => ""],
      ["in a popover", (note: string) => inDetails(note)],
      ["in a noscript", (note: string) => `<noscript>${note}</noscript>`],
      ["hidden", (note: string) => note.replace("<p ", "<p hidden ")],
      ["visually hidden", (note: string) => note.replace("<p ", '<p class="sr-only" ')],
      ["empty", (note: string) => note.replace("A dated warning.", "")],
    ])("fails on a note %s", (_name, hide) => {
      const body =
        plantedNotes([notes[0]]) + hide(plantedNotes([notes[1]])) + plantedNotesFlight(notes);
      expect(verifyOutput(mainWith(body), expected)).toEqual([
        "index.html: the velocity-warning note for ethereum isn't in view",
      ]);
    });

    it("a warning on another chain moves the note it asks for", () => {
      const moved = [notes[0], { ...notes[1], chain: "base" }];
      const body = plantedNotes(notes) + plantedNotesFlight(moved);
      const problems = verifyOutput(mainWith(body), {
        ...sampleExpected,
        essentialNotes: moved,
      });
      expect(problems).toEqual(["index.html: the velocity-warning note for base isn't in view"]);
    });

    it("fails on a note that keeps its kind and loses its words", () => {
      const body =
        plantedNotes([notes[0], { ...notes[1], text: "Fine." }]) + plantedNotesFlight(notes);
      expect(verifyOutput(mainWith(body), expected)).toEqual([
        'index.html: the velocity-warning note for ethereum doesn\'t say "A dated warning."',
      ]);
    });

    it("reads a note whole, across its date, its marker and its link", () => {
      const text = "Flows count from 3 Nov 2026 UTC, here.";
      const split = `<p data-note="day-0-scope"><span class="status-chip" data-kind="fact">F</span>
        Flows count from <!-- -->3 Nov 2026 UTC<!-- -->, <em>here</em>. <a href="/methodology/#x">How</a></p>`;
      expect(
        verifyOutput(mainWith(split + plantedNotesFlight([{ kind: "day-0-scope", text }])), {
          ...sampleExpected,
          essentialNotes: [{ kind: "day-0-scope", text }],
        }),
      ).toEqual([]);
    });

    describe("a kind on two cards", () => {
      const both = [
        { kind: "wallets-not-people", text: "Wallets, and more." },
        { kind: "wallets-not-people", text: "Wallets." },
      ];
      const twice = { ...sampleExpected, essentialNotes: both };

      it("passes with each instance", () => {
        expect(verifyOutput(mainWith(plantedNotes(both)), twice)).toEqual([]);
      });

      it.each([
        ["gone", () => ""],
        ["in a popover", (note: string) => inDetails(note)],
      ])("fails on one instance %s, though the other stays", (_name, hide) => {
        const body =
          plantedNotes([both[0]]) + hide(plantedNotes([both[1]])) + plantedNotesFlight(both);
        expect(verifyOutput(mainWith(body), twice)).toEqual([
          'index.html: the wallets-not-people note doesn\'t say "Wallets."',
        ]);
      });
    });
  });

  describe("the figures the dataset fixes", () => {
    it.each(["51.00%", "Tempo leads on three measures"])(
      "fails when a finding and its card both change to %s",
      (text) => {
        const both = page(
          MAIN.replaceAll(
            '<span class="finding__text">T</span>',
            `<span class="finding__text">${text}</span>`,
          ).replace("<h2>T</h2>", `<h2>${text}</h2>`),
        );
        const problems = verifyOutput(site({ main: both }), sampleExpected);
        expect([...new Set(problems)]).toEqual([
          "index.html: the finding for #card isn't the dataset's heading",
        ]);
      },
    );

    it("fails when a finding isn't there for one of the dataset's headings", () => {
      const expected = {
        ...sampleExpected,
        findings: [...PLANTED_FINDINGS, { id: "another-card", text: "T" }],
      };
      expect(verifyOutput(site(), expected)).toEqual([
        "index.html: the finding for #another-card isn't the dataset's heading",
      ]);
    });

    it("fails on a KPI value the dataset doesn't give", () => {
      const html = page(
        MAIN.replace("<span data-kpi-value>$1</span>", "<span data-kpi-value>$2</span>"),
      );
      expect(verifyOutput(site({ main: html }), sampleExpected)).toEqual([
        "index.html: A label isn't the dataset's figure",
      ]);
    });

    it("fails on two KPI values swapped", () => {
      const expected = { ...sampleExpected, kpiValues: ["$1", "$1", "$1", "$2"] };
      const swapped = page(
        MAIN.replace("<span data-kpi-value>$1</span>", "<span data-kpi-value>$2</span>"),
      );
      expect(verifyOutput(site({ main: swapped }), expected)).toEqual([
        "index.html: A label isn't the dataset's figure",
        "index.html: A label isn't the dataset's figure",
      ]);
    });
  });
});

describe("freshness in the output", () => {
  const withoutNote = (html: string) => html.replace(`<p data-stale-note>${STALE_NOTE}</p>`, "");

  it("fails when the page root reads fresh on a stale dataset", () => {
    const html = page(MAIN).replace('data-freshness="stale"', 'data-freshness="fresh"');
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      "index.html: page root says fresh, dataset is stale",
    );
  });

  it("fails with no freshness on the page root", () => {
    const html = page(MAIN).replace(' data-freshness="stale"', "");
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      "index.html: no freshness on the page root",
    );
  });

  it("fails when the stale note is dropped, on any page", () => {
    const methodology = withoutNote(page("<main>M</main>"));
    expect(verifyOutput(site({ methodology }), sampleExpected)).toContain(
      "methodology/index.html: no stale note",
    );
    const notFound = site({ extra: [["404.html", withoutNote(page("<p>Not found</p>"))]] });
    expect(verifyOutput(notFound, sampleExpected)).toContain("404.html: no stale note");
  });

  it("fails when the verdict block drops its stale text", () => {
    const html = page(MAIN.replace(`<p>${STALE_NOTE}</p></section>`, "</section>"));
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      "index.html: the verdict block has no stale text",
    );
  });

  it("fails when the trust strip drops its stale text, on real data", () => {
    const html = realPage(REAL_MAIN.replace(STALE_TRUST, "Reconciled"));
    const dir = site({ main: html, methodology: realPage("<main>M</main>") });
    expect(verifyOutput(dir, realExpected)).toContain(
      "index.html: the trust strip has no stale text",
    );
  });

  it("fails when the stale note is only in a details", () => {
    const html = page(MAIN).replace(
      `<p data-stale-note>${STALE_NOTE}</p>`,
      `<details><summary>More</summary><p data-stale-note>${STALE_NOTE}</p></details>`,
    );
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      "index.html: no stale note",
    );
  });

  it("fails when the verdict's stale text is only in a details", () => {
    const html = page(
      MAIN.replace(
        `<p>${STALE_NOTE}</p></section>`,
        `<details><summary>More</summary><p>${STALE_NOTE}</p></details></section>`,
      ),
    );
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      "index.html: the verdict block has no stale text",
    );
  });

  it("fails when the trust strip's text is only in a noscript, on real data", () => {
    const html = realPage(REAL_MAIN.replace(STALE_TRUST, `<noscript>${STALE_TRUST}</noscript>`));
    const dir = site({ main: html, methodology: realPage("<main>M</main>") });
    expect(verifyOutput(dir, realExpected)).toContain(
      "index.html: the trust strip has no stale text",
    );
  });

  it("reads a details' summary as in view", () => {
    const html = realPage(
      REAL_MAIN.replace(
        `${STALE_TRUST}${PLANTED_TRUST_DETAIL}`,
        PLANTED_TRUST_DETAIL.replace("Reconciliation detail", STALE_TRUST),
      ),
    );
    const dir = site({ main: html, methodology: realPage("<main>M</main>") });
    expect(verifyOutput(dir, realExpected)).toEqual([]);
  });

  it("fails when a fresh page's fresh sentence is only in a details", () => {
    const fresh = (body: string) =>
      realPage(body).replace('data-freshness="stale"', 'data-freshness="fresh"');
    const dir = site({
      main: fresh(
        FRESH_MAIN.replace(FRESH_TRUST, `<details><summary>More</summary>${FRESH_TRUST}</details>`),
      ),
      methodology: fresh("<main>M</main>"),
    });
    expect(verifyOutput(dir, freshRealExpected)).toContain(
      "index.html: the trust strip has no fresh text",
    );
  });

  it("fails when a fresh page drops the fresh sentence", () => {
    const fresh = (body: string) =>
      realPage(body).replace('data-freshness="stale"', 'data-freshness="fresh"');
    const dir = site({
      main: fresh(FRESH_MAIN.replace(FRESH_TRUST, "")),
      methodology: fresh("<main>M</main>"),
    });
    expect(verifyOutput(dir, freshRealExpected)).toContain(
      "index.html: the trust strip has no fresh text",
    );
  });

  it("fails on the reconciled sentence on a stale real dataset", () => {
    const dir = site({
      main: realPage(REAL_MAIN),
      methodology: realPage("<main>M</main>"),
      extra: [["index.txt", `{"a":"${FRESH_TRUST}"}`]],
    });
    expect(verifyOutput(dir, realExpected)).toContain(
      'index.txt: holds "Supply reconciled on all 4 chains" on stale data',
    );
  });

  it("takes the words and the state from the dataset", () => {
    const dir = releaseGrade();
    editJson(dir, "manifest.json", (manifest) => {
      manifest.stale = true;
      manifest.stale_since = "2026-11-04T07:00:00Z";
      manifest.stale_reason = "a check failed";
    });
    const expected = expectedFromDataset(at(dir));
    expect(expected.freshness).toBe("stale");
    expect(expected.asOfLine.stale).toContain("A newer run did not pass its checks.");
    expect(expected.trustLine.fresh).toBeNull();
  });
});

describe("the Preview frame", () => {
  const preview = { ...sampleExpected, kind: "preview", frameWord: "Preview" };

  it("wants the Preview word, not the Sample one", () => {
    const problems = verifyOutput(site(), preview);
    expect(problems).toContain("index.html: page root says sample, dataset is preview");
    expect(problems).toContain("index.html: no [Preview] in the title");
    expect(problems).toContain(
      'index.html: the verdict chip doesn\'t say "Preview, not a finding"',
    );
  });

  it("passes a good preview site", () => {
    const as = (html: string) =>
      html
        .replaceAll('data-dataset-kind="sample"', 'data-dataset-kind="preview"')
        .replaceAll("Sample data. Nothing here is real.", "Local preview. Not the published site.")
        .replaceAll("[Sample]", "[Preview]")
        .replaceAll("Sample", "Preview");
    const dir = site({ main: as(page(MAIN)), methodology: as(page("<main>M</main>")) });
    expect(verifyOutput(dir, preview)).toEqual([]);
  });
});

describe("what to expect comes from the dataset", () => {
  it("a sample expects the sample frame, wherever it's been copied", () => {
    const dir = releaseGrade();
    editJson(dir, "manifest.json", (manifest) => {
      manifest.git_commit = "0".repeat(40);
    });
    expect(expectedFromDataset(at(dir))).toMatchObject({ kind: "sample", frameWord: "Sample" });
  });

  it("a release-grade dataset expects no frame, and collects its pipeline strings", () => {
    const dir = releaseGrade();
    editJson(dir, "manifest.json", (manifest) => {
      manifest.stale = true;
      manifest.stale_since = "2026-11-04T07:00:00Z";
      manifest.stale_reason = "chain_supply is failed, so nothing moved";
    });
    const expected = expectedFromDataset(at(dir));
    expect(expected).toMatchObject({ kind: "real", frameWord: null });
    expect(expected.pipelineStrings).toContain("chain_supply is failed, so nothing moved");
    expect(expected.pipelineStrings).toHaveLength(8);
  });

  it("the partial sample expects its sample frame, not preview", () => {
    expect(expectedFromDataset(at(copySample("partial"))).frameWord).toBe("Sample");
  });

  it("takes the headline from the dataset, and keeps verdict.text in view unless it may move", () => {
    const sample = expectedFromDataset(at(copySample("complete")));
    expect(sample.verdict.sentence).toBe(
      "At least half of Open USD (OUSD) supply is sitting still.",
    );
    expect(sample.verdict.textVisible).toBe(true);
    expect(expectedFromDataset(at(copySample("partial"))).verdict.textVisible).toBe(true);
    const real = expectedFromDataset(at(releaseGrade()));
    expect(real.verdict.textVisible).toBe(false);
    expect(real.verdict.items.length).toBeGreaterThan(0);
  });

  it("asks for every caveat the dataset's conditions call for", () => {
    const kinds = (dir: string) =>
      expectedFromDataset(at(dir)).essentialNotes.map((note: { kind: string }) => note.kind);
    expect(kinds(releaseGrade())).toEqual(
      expect.arrayContaining([
        "placed",
        "series-start",
        "small-ticket",
        "velocity-denominators",
        "no-swaps",
        "wallets-not-people",
        "hops",
        "everyday-meaning",
        "history",
      ]),
    );
    expect(kinds(releaseGrade())).not.toContain("velocity-warning");
    const warned = releaseGrade();
    editJson(warned, "manifest.json", (manifest) => {
      manifest.warnings = [
        {
          chain: "base",
          metric: "circulating_supply",
          day: "2026-11-02",
          previous: "2",
          current: "1",
        },
        { chain: "tempo", metric: "total_supply", day: "2026-11-02", previous: "1", current: "2" },
      ];
    });
    const warnings = expectedFromDataset(at(warned)).essentialNotes.filter(
      (note: { kind: string }) => note.kind === "velocity-warning",
    );
    expect(warnings).toEqual([
      expect.objectContaining({
        chain: "base",
        text: expect.stringContaining("Base's circulating supply"),
      }),
    ]);
  });

  it("asks for the unlabelled issuer's note on the chain that has one", () => {
    const dir = releaseGrade();
    editJson(dir, "journey.json", (payload) => {
      for (const row of payload.data) {
        row.issuer_labeled = row.chain !== "base";
        if (row.chain === "base") {
          row.free_floating = (BigInt(row.free_floating) + BigInt(row.issuer_inventory)).toString();
          row.issuer_inventory = "0";
        }
      }
    });
    const notes = expectedFromDataset(at(dir)).essentialNotes;
    expect(notes).toContainEqual({
      kind: "issuer-unlabeled",
      chain: "base",
      text: "Base: issuer inventory reads as zero because no wallet there is labelled.",
    });
    expect(notes.filter((note: { kind: string }) => note.kind === "issuer-unlabeled")).toHaveLength(
      1,
    );
  });

  it("words each caveat from the dataset, and asks for both wallet notes", () => {
    const dir = releaseGrade();
    editJson(dir, "manifest.json", (manifest) => {
      manifest.definitions.placed_days = 21;
      manifest.definitions.large_transfer_base_units = "2000000000000";
    });
    const notes = expectedFromDataset(at(dir)).essentialNotes as { kind: string; text: string }[];
    const text = (kind: string) => notes.filter((note) => note.kind === kind).map((n) => n.text);
    expect(text("series-start")[0]).toContain("Placed supply needs 21 days of history");
    expect(text("everyday-meaning")).toEqual(["Everyday means under $2M, nothing more."]);
    expect(text("wallets-not-people")).toEqual([
      "Wallets, not people, and never added across chains.",
      "Wallets, not people.",
    ]);
    expect(text("history")[0]).toMatch(
      /^Weeks end on the date shown, in UTC\. \d+ days of history/,
    );
  });

  it("recomputes the four headings and the KPI values from the dataset", () => {
    const dir = releaseGrade();
    const before = expectedFromDataset(at(dir));
    expect(before.findings.map((finding: { id: string }) => finding.id)).toEqual([
      CARD_ANCHORS.supply,
      CARD_ANCHORS.waterfall,
      CARD_ANCHORS.weekly,
      CARD_ANCHORS.chainRoles,
    ]);
    editJson(dir, "journey.json", (payload) => {
      for (const row of payload.data) {
        const moved = BigInt(row.placed_supply);
        row.placed_supply = "0";
        row.placed_exchange_linked = "0";
        row.free_floating = (BigInt(row.free_floating) + moved).toString();
      }
    });
    const after = expectedFromDataset(at(dir));
    expect(after.findings[0].text).not.toBe(before.findings[0].text);
    expect(after.findings[0].text).toContain("0.00% of supply");
    expect(after.findings.slice(1)).toEqual(before.findings.slice(1));
    editJson(dir, "summary.json", (summary) => {
      for (const row of summary.kpis) row.clean_everyday_7d = "0";
    });
    const moved = expectedFromDataset(at(dir)).kpiValues;
    expect(moved[2]).toBe("$0");
    expect(before.kpiValues[2]).not.toBe("$0");
  });

  it("reads the same dataset the build does", () => {
    const location = locateDataset({ OUSD_DATASET_DIR: "fixtures/dataset/complete" });
    expect(expectedFromDataset(location).version).toBe("20261104T060000Z");
  });
});

describe("exchange names on the main page", () => {
  const KRAKEN_SOURCE =
    "https://blog.kraken.com/product/asset-listings/ousd-is-available-for-trading";
  const rows = [
    {
      entity: "Coinbase",
      detail: "7 wallets, at least $346,579",
      sourceHref: "/methodology/#named-labels",
      sourceText: "each wallet's label",
    },
    {
      entity: "Kraken",
      detail: "no wallet labeled",
      sourceHref: KRAKEN_SOURCE,
      sourceText: "its OUSD listing",
    },
  ];
  const named = { ...sampleExpected, exchangeRows: rows };
  const row = (entity: string, detail: string, href: string, text: string) =>
    `<li data-exchange-row><span data-exchange-name>${entity}</span>, <span data-exchange-detail>${detail}</span>. Source: <a href="${href}" rel="noopener noreferrer" data-exchange-source>${text}</a>.</li>`;
  const COINBASE = row("Coinbase", rows[0].detail, rows[0].sourceHref, rows[0].sourceText);
  const KRAKEN = row("Kraken", rows[1].detail, rows[1].sourceHref, rows[1].sourceText);
  const ROWS_ONLY = `<ul>${COINBASE}${KRAKEN}</ul>`;
  const BOTH = `${ROWS_ONLY}${plantedFlight(rows.map(plantedRowFlight))}`;

  it("allows a dataset's exchange as a row's name, beside its source", () => {
    expect(verifyOutput(mainWith(BOTH), named)).toEqual([]);
  });

  it("refuses the same name anywhere else on the page", () => {
    for (const elsewhere of [
      "<p>Coinbase holds this.</p>",
      "<p>Coinbase</p>",
      "<p>Coin&#98;ase</p>",
      '<div title="Coinbase"></div>',
      "<template><p>Coinbase</p></template>",
      "<noscript><p>Coinbase</p></noscript>",
    ]) {
      expect(verifyOutput(mainWith(`${BOTH}${elsewhere}`), named)).toEqual([
        'index.html: names "Coinbase"',
      ]);
    }
  });

  it("refuses the name however it's written", () => {
    for (const elsewhere of [
      "<p>COINBASE holds the band</p>",
      "<p>coinbase holds the band</p>",
      "<p>CoinbasePrime holds the band</p>",
      "<p>Coin<b>base</b> holds the band</p>",
      "<p>Coin\u200bbase holds the band</p>",
      '<div title="coinbase"></div>',
    ]) {
      expect(verifyOutput(mainWith(`${BOTH}${elsewhere}`), named)).toEqual([
        'index.html: names "Coinbase"',
      ]);
    }
    const main = page(`${MAIN}${BOTH}`);
    expect(
      verifyOutput(site({ main, extra: [["index.txt", '{"a":"Coin\\u0062ase"}']] }), named),
    ).toContain('index.txt: names "Coinbase"');
    expect(verifyOutput(site({ main, extra: [["index.txt", '{"a":"KRAKEN"}']] }), named)).toContain(
      'index.txt: names "Kraken"',
    );
  });

  it("allows a row's source link to hold its host, and no other link", () => {
    const other = '<a href="https://blog.kraken.com/other" rel="noopener noreferrer">More</a>';
    expect(verifyOutput(mainWith(`${BOTH}${other}`), named)).toContain(
      'index.html: names "Kraken"',
    );
  });

  it("refuses the name in the head", () => {
    const main = page(`${MAIN}${BOTH}`, undefined, "[Sample] Coinbase");
    expect(verifyOutput(site({ main }), named)).toContain('index.html: names "Coinbase"');
  });

  it("refuses a dataset's exchange outside its row, on the list or not", () => {
    const unlisted = [{ ...rows[0], entity: "Sample Exchange" }];
    const shown = row("Sample Exchange", rows[0].detail, rows[0].sourceHref, rows[0].sourceText);
    const flight = plantedFlight(unlisted.map(plantedRowFlight));
    const problems = verifyOutput(mainWith(`<ul>${shown}</ul>${flight}<p>Sample Exchange</p>`), {
      ...sampleExpected,
      exchangeRows: unlisted,
    });
    expect(problems).toEqual(['index.html: names "Sample Exchange"']);
  });

  it("allows a row's own name in the page's payload, once, and nothing more", () => {
    expect(verifyOutput(mainWith(BOTH), named)).toEqual([]);
    const own = '\\"data-exchange-name\\":true,\\"children\\":\\"Coinbase\\"';
    const script = (text: string) => `<script>self.__next_f.push([1,"${text}"])</script>`;
    for (const text of ['\\"Coinbase holds the band\\"', '\\"bandOwner\\":\\"Coinbase\\"', own]) {
      expect(verifyOutput(mainWith(`${BOTH}${script(text)}`), named)).toContain(
        'index.html: names "Coinbase"',
      );
    }
  });

  it("holds the main page's payload files to the same, and other pages' to none", () => {
    const main = page(`${MAIN}${BOTH}`);
    const fine: [string, string] = [
      "index.txt",
      `1:${JSON.stringify(rows.map(plantedRowFlight))}\n`,
    ];
    expect(verifyOutput(site({ main, extra: [fine] }), named)).toEqual([]);
    for (const content of ['{"children":"Coinbase holds the band"}', '{"bandOwner":"Coinbase"}']) {
      expect(verifyOutput(site({ main, extra: [["index.txt", content]] }), named)).toContain(
        'index.txt: names "Coinbase"',
      );
    }
    const other: [string, string] = ["_not-found/index.txt", fine[1]];
    expect(verifyOutput(site({ main, extra: [other] }), named)).toContain(
      `${join("_not-found", "index.txt")}: names "Coinbase"`,
    );
  });

  it("holds a dataset's exchange to the payload rule even if the list misses it", () => {
    const entry = { ...rows[0], entity: "Sample Exchange" };
    const shown = row("Sample Exchange", rows[0].detail, rows[0].sourceHref, rows[0].sourceText);
    const main = page(`${MAIN}<ul>${shown}</ul>${plantedFlight([plantedRowFlight(entry)])}`);
    const problems = verifyOutput(
      site({ main, extra: [["__next._tree.txt", '{"bandOwner":"Sample Exchange"}']] }),
      { ...sampleExpected, exchangeRows: [entry] },
    );
    expect(problems).toEqual(['__next._tree.txt: names "Sample Exchange"']);
  });

  it("refuses a row that says more than the dataset gives", () => {
    const added = KRAKEN.replace("</li>", " This exchange holds the unnamed band.</li>");
    expect(verifyOutput(mainWith(`<ul>${COINBASE}${added}</ul>`), named)).toContain(
      `index.html: the row for "Kraken" says more than the dataset gives`,
    );
    const second = KRAKEN.replace("</li>", "<span data-exchange-name>Coinbase</span></li>");
    const problems = verifyOutput(mainWith(`<ul>${COINBASE}${second}</ul>`), named);
    expect(problems).toContain(`index.html: the row for "Kraken" says more than the dataset gives`);
    expect(problems).toContain('index.html: names "Coinbase"');
  });

  it("refuses a row hidden however the markup can say so", () => {
    for (const hiding of [
      'style="opacity:0"',
      'style="font-size: 0"',
      'style="display :none"',
      'style="position:absolute;left:-9999px"',
      'class="hidden"',
    ]) {
      const hidden = COINBASE.replace("<li ", `<li ${hiding} `);
      expect(verifyOutput(mainWith(`<ul>${hidden}${KRAKEN}</ul>`), named)).toContain(
        `index.html: the row for "Coinbase" is hidden`,
      );
    }
    const revealed = COINBASE.replace("<li ", '<li class="hidden md:block" ');
    const flight = plantedFlight(rows.map(plantedRowFlight));
    expect(verifyOutput(mainWith(`<ul>${revealed}${KRAKEN}</ul>${flight}`), named)).toEqual([]);
    const name = COINBASE.replace(
      "<span data-exchange-name",
      '<span style="opacity:0" data-exchange-name',
    );
    expect(verifyOutput(mainWith(`<ul>${name}${KRAKEN}</ul>`), named)).toContain(
      `index.html: the row for "Coinbase" is hidden`,
    );
  });

  describe("the page's serialized copy", () => {
    const el = (type: string, props: object) => ["$", type, null, props];
    const floor = { kind: "exchange-floor", text: "Exchange venues are a floor.", exact: true };
    const withNotes = { ...named, essentialNotes: [floor] };
    const NOTES = plantedNotes([floor]);
    const floorProps = (children: unknown) => el("p", { "data-note": floor.kind, children });
    const flight = (tree: unknown) => `1:${JSON.stringify(tree)}\n`;
    const main = page(`${MAIN}${BOTH}${NOTES}`);
    const goodRows = () => rows.map(plantedRowFlight);
    const withRow = (index: number, detail: string, href = rows[index].sourceHref) =>
      goodRows().map((r, at) =>
        at === index ? plantedRowFlight({ ...rows[index], detail, sourceHref: href }) : r,
      );
    const run = (payload: string) =>
      verifyOutput(site({ main, extra: [["index.txt", payload]] }), withNotes);
    const good = [goodRows(), floorProps(floor.text)];

    it("passes when it matches", () => {
      expect(run(flight(good))).toEqual([]);
    });

    it("refuses another figure or a claim of wallets in a row", () => {
      expect(run(flight([withRow(0, "7 wallets, at least $9"), floorProps(floor.text)]))).toEqual([
        `index.txt: the payload's row for "Coinbase" isn't the dataset's`,
      ]);
      expect(run(flight([withRow(1, "3 wallets, at least $1"), floorProps(floor.text)]))).toEqual([
        `index.txt: the payload's row for "Kraken" isn't the dataset's`,
      ]);
    });

    it("refuses another source, a missing row and a reworded note", () => {
      const source = withRow(1, rows[1].detail, "https://example.com/x");
      expect(run(flight([source, floorProps(floor.text)]))).toEqual([
        `index.txt: the payload's row for "Kraken" hasn't the dataset's source`,
      ]);
      expect(run(flight([goodRows()[0], floorProps(floor.text)]))).toContain(
        "index.txt: the payload has 1 exchange rows",
      );
      expect(run(flight([goodRows(), floorProps("Exchange venues are fine.")]))).toEqual([
        "index.txt: the payload's exchange-floor note isn't the dataset's",
      ]);
    });

    it("reads the copy inside the page however its call is spaced, and follows a reference", () => {
      const changed = [withRow(0, "1 wallet, at least $9"), floorProps(floor.text)];
      const spaced = `<script>self.__next_f.push([1, ${JSON.stringify(flight(changed))}])</script>`;
      const inPage = page(`${MAIN}${ROWS_ONLY}${NOTES}${spaced}`);
      expect(verifyOutput(site({ main: inPage }), withNotes)).toContain(
        `index.html: the payload's row for "Coinbase" isn't the dataset's`,
      );
      const referenced = `2:"Exchange venues are a floor."\n${flight([goodRows(), floorProps("$L2")])}`;
      expect(run(referenced)).toEqual([]);
    });

    it("fails with nothing to read, rather than turning itself off", () => {
      const bare = page(MAIN).replace(/<script>self\.__next_f.*?<\/script>/, "");
      expect(verifyOutput(site({ main: bare }), sampleExpected)).toContain(
        "index.html: the page's payload can't be read",
      );
      for (const name of ["index.txt", "__next._full.txt", "__next.__PAGE__.txt"]) {
        expect(verifyOutput(site({ extra: [[name, ""]] }), sampleExpected)).toContain(
          `${name}: the page's payload can't be read`,
        );
      }
    });

    it("reports a chunk it can't parse, rather than crashing", () => {
      const broken = '<script>self.__next_f.push([1,"bad\\q"])</script>';
      expect(verifyOutput(mainWith(broken), sampleExpected)).toContain(
        "index.html: a chunk of the page's payload can't be read",
      );
    });

    it("doesn't ask the route's tree or another page's payload for rows", () => {
      const other = flight(el("div", { children: "Not found" }));
      expect(
        verifyOutput(
          site({
            main,
            extra: [
              ["__next._tree.txt", other],
              ["_not-found/index.txt", other],
            ],
          }),
          withNotes,
        ),
      ).toEqual([]);
    });
  });

  describe("the band", () => {
    const bands: PlantedBand[] = [
      {
        key: "all",
        name: "all",
        amount: "5000000",
        line: "Exchange-linked, inside placed: $5 (1.00% of supply)",
        exact: "$5",
      },
      {
        key: "ethereum",
        name: "Ethereum",
        amount: "5000000",
        line: "Exchange-linked, inside placed: $5 (2.00% of supply)",
        exact: "$5",
      },
    ];
    const expected = { ...sampleExpected, bands };

    it("passes when each line, table row and payload amount is the dataset's", () => {
      expect(verifyOutput(mainWith(plantedBands(bands)), expected)).toEqual([]);
    });

    it("refuses another amount in the line, the table or the payload", () => {
      const line = plantedBands(bands).replace(": $5 (2", ": $9 (2");
      expect(verifyOutput(mainWith(line), expected)).toContain(
        "index.html: the exchange-linked line for ethereum isn't the dataset's",
      );
      const table = plantedBands(bands).replace("<td>$5</td>", "<td>$9</td>");
      expect(verifyOutput(mainWith(table), expected)).toContain(
        "index.html: the table has another exchange-linked amount for ethereum",
      );
      const changed = bands.map((band) => ({ ...band, amount: "9000000" }));
      const payload = plantedBands(bands).replace(/<script>.*<\/script>/, "");
      const inPage = `${payload}${plantedBands(changed).match(/<script>.*<\/script>/)![0]}`;
      expect(verifyOutput(mainWith(inPage), expected)).toContain(
        "index.html: the payload's exchange-linked amount for all isn't the dataset's",
      );
    });

    it("refuses a missing line", () => {
      expect(verifyOutput(mainWith(""), expected)).toContain(
        "index.html: there are 0 exchange-linked lines",
      );
    });
  });

  it("holds a caveat marked exact to its words, and nothing added", () => {
    const floor = { kind: "exchange-floor", text: "A floor.", exact: true };
    const expected = { ...sampleExpected, essentialNotes: [floor] };
    expect(verifyOutput(mainWith(plantedNotes([floor])), expected)).toEqual([]);
    const added = plantedNotes([{ ...floor, text: "A floor. And it holds more." }]);
    expect(verifyOutput(mainWith(added), expected)).toContain(
      'index.html: the exchange-floor note doesn\'t say "A floor."',
    );
  });

  it("refuses a hidden row or a hidden source, and allows a closed disclosure", () => {
    const hiddenRow = COINBASE.replace("<li ", "<li hidden ");
    expect(verifyOutput(mainWith(`<ul>${hiddenRow}${KRAKEN}</ul>`), named)).toContain(
      `index.html: the row for "Coinbase" is hidden`,
    );
    expect(verifyOutput(mainWith(`<noscript><ul>${BOTH}</ul></noscript>`), named)).toContain(
      `index.html: the row for "Coinbase" is hidden`,
    );
    const hiddenLink = KRAKEN.replace("<a ", "<a hidden ");
    expect(verifyOutput(mainWith(`<ul>${COINBASE}${hiddenLink}</ul>`), named)).toContain(
      `index.html: the row for "Kraken" is hidden`,
    );
    const toggle = `<details class="data-toggle"><summary>Table</summary>${BOTH}</details>`;
    expect(verifyOutput(mainWith(toggle), named)).toEqual([]);
  });

  it("keeps every other labeled name blocked, even in a row's shape", () => {
    const bybit = row("Bybit", "1 wallet, at least $1", rows[0].sourceHref, rows[0].sourceText);
    const problems = verifyOutput(mainWith(`<ul>${COINBASE}${KRAKEN}${bybit}</ul>`), named);
    expect(problems).toContain("index.html: there are 3 exchange rows");
    expect(problems).toContain('index.html: names "Bybit"');
  });

  it("blocks an exchange the dataset doesn't list, as before", () => {
    const problems = verifyOutput(mainWith(COINBASE), sampleExpected);
    expect(problems).toContain("index.html: there are 1 exchange rows");
    expect(problems).toContain('index.html: names "Coinbase"');
  });

  it("refuses a missing row, a wrong figure and a wrong source", () => {
    expect(verifyOutput(mainWith(`<ul>${COINBASE}</ul>`), named)).toContain(
      "index.html: exchange row 2 isn't the dataset's name",
    );
    const figure = row(
      "Coinbase",
      "7 wallets, at least $9",
      rows[0].sourceHref,
      rows[0].sourceText,
    );
    expect(verifyOutput(mainWith(`<ul>${figure}${KRAKEN}</ul>`), named)).toContain(
      `index.html: the row for "Coinbase" isn't the dataset's figure`,
    );
    const source = row("Kraken", rows[1].detail, "https://example.com/other", rows[1].sourceText);
    expect(verifyOutput(mainWith(`<ul>${COINBASE}${source}</ul>`), named)).toContain(
      `index.html: the row for "Kraken" hasn't the source the dataset gives`,
    );
    const bare = `<li data-exchange-row><span data-exchange-name>Kraken</span>, <span data-exchange-detail>${rows[1].detail}</span>.</li>`;
    expect(verifyOutput(mainWith(`<ul>${COINBASE}${bare}</ul>`), named)).toContain(
      `index.html: the row for "Kraken" hasn't the source the dataset gives`,
    );
  });

  it("keeps a wallet's address off the main page, in a row's link too", () => {
    const address = "0x20fe51a9229eef2cf8ad9e89d91cab9312cf3b7a";
    const linked = row(
      "Coinbase",
      rows[0].detail,
      `https://basescan.org/address/${address}`,
      rows[0].sourceText,
    );
    const problems = verifyOutput(mainWith(`<ul>${linked}${KRAKEN}</ul>`), named);
    expect(problems).toContain("index.html: an address in the page");
  });

  it("expects the dataset's rows, and requires its notes", () => {
    const expected = expectedFromDataset(at(releaseGrade()));
    expect(expected.exchangeRows.map((entry: { entity: string }) => entry.entity)).toEqual([
      "Sample Exchange",
      "Sample Listing",
    ]);
    const kinds = expected.essentialNotes.map((note: { kind: string }) => note.kind);
    expect(kinds).toContain("exchange-floor");
    expect(kinds).toContain("exchange-coverage");
  });
});

describe("web code", () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return [".ts", ".tsx", ".mjs"].includes(extname(name)) ? [path] : [];
    });

  it("never references an RPC variable, outside the check that looks for one", () => {
    const files = ["app", "components", "lib", "scripts"].flatMap(sourceFiles);
    const offenders = files.filter(
      (path) =>
        path !== join("scripts", "verify-output.mjs") &&
        /_RPC_URL/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("reads the dataset only through the server-only entry", () => {
    expect(readFileSync("lib/dataset/index.ts", "utf8")).toMatch(/^import "server-only";/);
    const files = ["app", "components"].flatMap(sourceFiles);
    const offenders = files.filter((path) => /lib\/dataset\/load/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no client component imports the loader's entry for data", () => {
    const client = sourceFiles("components").filter((path) =>
      readFileSync(path, "utf8").startsWith('"use client"'),
    );
    expect(client.length).toBeGreaterThan(0);
    for (const path of client) {
      expect(readFileSync(path, "utf8")).not.toMatch(/from "@\/lib\/dataset"/);
    }
  });

  it("reads no environment variable but the dataset path", () => {
    const names = sourceFiles("lib").flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]),
    );
    expect(new Set(names)).toEqual(new Set(["OUSD_DATASET_DIR"]));
  });
});
