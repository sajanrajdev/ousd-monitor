import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKEN_CONTRACTS } from "@/lib/definitions";
import { verifyOutput } from "@/scripts/verify-output.mjs";
import { plantFile, tempDir } from "./dataset-helpers";
import {
  plantedExchangeRows,
  plantedFlight,
  plantedNotes,
  plantedRowFlight,
  plantedTip,
} from "./planted-first-screen";
import {
  LINE,
  BLOCKED,
  CARD,
  STALE_NOTE,
  STALE_TRUST,
  SHORT_TRUST,
  HEAD_STALE,
  RUN_STALE,
  sampleExpected,
  realExpected,
  freshRealExpected,
  page,
  MAIN,
  site,
  mainWith,
  REAL_HEADLINE,
  REAL_REST,
  REAL_MAIN,
  FRESH_MAIN,
  realPage,
  freshPage,
} from "./verify-output-fixture";

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
    const dir = site({
      main: freshPage(FRESH_MAIN),
      methodology: freshPage("<main>Methodology</main>"),
    });
    expect(verifyOutput(dir, freshRealExpected)).toEqual([]);
  });

  it("passes a good real site that was already old when built, saying so in the footer alone", () => {
    const old = {
      ...freshRealExpected,
      freshness: "stale",
      passing: false,
      asOfLine: { fresh: null, stale: STALE_NOTE },
      trustLine: { fresh: null, stale: STALE_TRUST, short: SHORT_TRUST },
      runLine: { fresh: null, stale: RUN_STALE },
    };
    const oldPage = (body: string) => realPage(body).replace(/<p data-stale-note>.*?<\/p>/, "");
    const main = `<main><section data-section="verdict">${REAL_HEADLINE}<p>${HEAD_STALE}</p></section>${REAL_REST}</main>`;
    const dir = site({ main: oldPage(main), methodology: oldPage("<main>Methodology</main>") });
    expect(verifyOutput(dir, old)).toEqual([]);
    // The footer must show its clock state, in view.
    const hidden = site({
      main: oldPage(main).replace("data-stale-status>", 'data-stale-status style="display:none">'),
      methodology: oldPage("<main>Methodology</main>"),
    });
    expect(verifyOutput(hidden, old)).toContain(
      "index.html: the footer's clock state isn't in view on old data",
    );
  });

  it("fails when a page is missing", () => {
    const dir = tempDir();
    plantFile(dir, "index.html", page(MAIN));
    expect(verifyOutput(dir, sampleExpected)).toContain("methodology/index.html: missing");
  });

  it("fails with no reconciliation page", () => {
    const problems = verifyOutput(site({ reconciliation: null }), sampleExpected);
    expect(problems).toContain("reconciliation/index.html: missing");
  });

  it("fails with no independence line, on every page", () => {
    const html = page(MAIN).replaceAll(LINE, "Something else");
    const problems = verifyOutput(site({ main: html }), sampleExpected);
    expect(problems).toContain("index.html: no independence line in the footer");
    expect(problems).not.toContain("methodology/index.html: no independence line in the footer");
    const elsewhere = verifyOutput(
      site({ methodology: page("<main>Methodology</main>").replaceAll(LINE, "Else") }),
      sampleExpected,
    );
    expect(elsewhere).toContain("methodology/index.html: no independence line in the footer");
    expect(elsewhere).toContain("reconciliation/index.html: no independence line in the footer");
  });

  it("no longer needs the independence line in the header, which keeps only the name", () => {
    expect(page(MAIN)).not.toMatch(new RegExp(`<header>[^]*${LINE}[^]*</header>`));
    expect(verifyOutput(site(), sampleExpected)).toEqual([]);
  });

  it.each([
    ["gone", (html: string) => html.replace(`<footer><p>${LINE}</p>`, "<footer>")],
    [
      "in a details",
      (html: string) =>
        html.replace(
          `<footer><p>${LINE}</p>`,
          `<footer><details><summary>More</summary><p>${LINE}</p></details>`,
        ),
    ],
    [
      "in a tooltip",
      (html: string) =>
        html.replace(`<footer><p>${LINE}</p>`, `<footer>${plantedTip("About", LINE)}`),
    ],
    [
      "in a noscript",
      (html: string) =>
        html.replace(`<footer><p>${LINE}</p>`, `<footer><noscript><p>${LINE}</p></noscript>`),
    ],
    [
      "visually hidden",
      (html: string) =>
        html.replace(`<footer><p>${LINE}</p>`, `<footer><p class="sr-only">${LINE}</p>`),
    ],
    [
      "hidden",
      (html: string) => html.replace(`<footer><p>${LINE}</p>`, `<footer><p hidden>${LINE}</p>`),
    ],
  ])("fails with the footer's independence line %s", (_name, change) => {
    const problems = verifyOutput(site({ main: change(page(MAIN)) }), sampleExpected);
    expect(problems).toContain("index.html: no independence line in the footer");
  });

  it("fails with no methodology link in the footer", () => {
    const html = page(MAIN).replace('<nav><a href="/methodology">Methodology</a></nav>', "");
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      "index.html: no methodology link in the footer",
    );
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
        "no frame words on the verdict",
        (html: string) => html.replace("Sample, not a finding.", "Our reading"),
        'the verdict doesn\'t say "Sample, not a finding." in view',
      ],
      [
        "the frame words back in a marker chip",
        (html: string) =>
          html.replace(
            "<p data-verdict-frame>Sample, not a finding.</p>",
            '<p data-verdict-frame><span class="status-chip" data-kind="opinion">Sample, not a finding.</span></p>',
          ),
        "a marker is back on the main page",
      ],
      [
        "the frame words in a tooltip",
        (html: string) =>
          html.replace(
            "<p data-verdict-frame>Sample, not a finding.</p>",
            `<p data-verdict-frame>${plantedTip("Note", "Sample, not a finding.")}</p>`,
          ),
        'the verdict doesn\'t say "Sample, not a finding." in view',
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
        "the verdict's frame words in a details",
        (html: string) =>
          html.replace(
            "<p data-verdict-frame>Sample, not a finding.</p>",
            "<details><summary>More</summary><p data-verdict-frame>Sample, not a finding.</p></details>",
          ),
        'the verdict doesn\'t say "Sample, not a finding." in view',
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
            .replace(
              "</section>",
              `<details><summary>More</summary><p class="chart-card__meta">${TIME}</p></details></section>`,
            ),
        "a card has no visible as-of time",
      ],
      [
        "as-of time but in its tooltip",
        (card: string) =>
          card
            .replace(TIME, "")
            .replace(POPOVER_SOURCE, `${POPOVER_SOURCE}<p class="chart-card__meta">${TIME}</p>`),
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
        "source in the tooltip",
        (card: string) => card.replace(POPOVER_SOURCE, ""),
        "a card's tooltip has no source",
      ],
      [
        "definition link in the tooltip",
        (card: string) => card.replace(POPOVER_LINK, "</div>"),
        "a card's tooltip has no definition link",
      ],
      [
        "noscript note, so the source is only in the tooltip",
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
        "</section>",
        '<details><summary>More</summary><p class="chart-card__meta"><strong>Sample</strong></p></details></section>',
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

    it("has no marker on a card, and fails on one put back, wherever it is", () => {
      expect(CARD).not.toContain("status-chip");
      for (const marked of [
        CARD.replace(HEADING, `${HEADING}${CHIP}`),
        CARD.replace("<table>", `${CHIP}<table>`),
        CARD.replace(POPOVER_SOURCE, `${POPOVER_SOURCE}${CHIP}`),
      ]) {
        const html = page(MAIN.replace(CARD, marked));
        expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
          "index.html: a marker is back on the main page",
        );
      }
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
        "a tooltip source with no value",
        (card: string) => card.replace("<p>Source: S</p>", "<p>Source: </p>"),
        "a card's tooltip has no source",
      ],
      [
        "a noscript source with no value",
        (card: string) => card.replace("Source: S · ", "Source:  · "),
        "a card's noscript note has no source",
      ],
      [
        "a tooltip link that isn't to the methodology",
        (card: string) =>
          card.replace(
            '<a href="/methodology/#velocity">Definition</a></div>',
            '<a href="#velocity">Definition</a></div>',
          ),
        "a card's tooltip has no definition link",
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

    const FOOTNOTES =
      '<details class="footnotes" data-footnotes><summary>Footnotes</summary><ol class="footnotes__list"><li>A caveat</li></ol></details>';
    it.each([
      ["a details", `<details><summary>More</summary>${FOOTNOTES}</details>`],
      ["a noscript", `<noscript>${FOOTNOTES}</noscript>`],
      ["a tooltip", plantedTip("Notes", FOOTNOTES)],
    ])("fails on footnotes inside %s", (_name, html) => {
      expect(verifyOutput(mainWith(html), sampleExpected)).toContain(
        "index.html: footnotes inside a details, noscript or tooltip",
      );
    });

    it("passes footnotes on their card, and fails them open by default", () => {
      const card = plantedNotes([{ kind: "placed", text: "A caveat." }]);
      expect(verifyOutput(mainWith(card), sampleExpected)).toEqual([]);
      const open = card.replace('<details class="footnotes"', '<details open class="footnotes"');
      expect(verifyOutput(mainWith(open), sampleExpected)).toContain(
        "index.html: a card's footnotes are open by default",
      );
    });
  });
});

describe('"Our reading" and the frame words', () => {
  it("is fine as a group's title in the reading's tooltip, on a framed page", () => {
    const heading = MAIN.replace("<p>An estimate.</p>", "<p>An estimate.</p><p>Our reading</p>");
    expect(heading).not.toBe(MAIN);
    expect(verifyOutput(site({ main: page(heading) }), sampleExpected)).toEqual([]);
  });

  it("is fine in the methodology page's table, on a framed page", () => {
    const table = page(
      "<main><table><tr><td>Our reading</td><td>An opinion about the facts</td></tr></table></main>",
    );
    expect(verifyOutput(site({ methodology: table }), sampleExpected)).toEqual([]);
  });

  it("fails when the frame words aren't the verdict's own line", () => {
    const html = page(MAIN).replace(
      "<p data-verdict-frame>Sample, not a finding.</p>",
      "<p>Sample, not a finding.</p>",
    );
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      'index.html: the verdict doesn\'t say "Sample, not a finding." in view',
    );
  });

  it("fails when real data says it isn't a finding", () => {
    const html = REAL_MAIN.replace(
      `<p>${STALE_NOTE}</p>`,
      `<p data-verdict-frame>Sample, not a finding.</p><p>${STALE_NOTE}</p>`,
    );
    const dir = site({ main: realPage(html), methodology: realPage("<main>Methodology</main>") });
    expect(verifyOutput(dir, realExpected)).toContain(
      "index.html: real data says it isn't a finding",
    );
  });
});
