import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { locateDataset } from "@/lib/dataset/load";
import { TOKEN_CONTRACTS } from "@/lib/definitions";
import { expectedFromDataset, verifyOutput } from "@/scripts/verify-output.mjs";
import { at, copySample, editJson, plantFile, releaseGrade, tempDir } from "./dataset-helpers";

const LINE = "Independent. Not affiliated with Open Standard or Bridge.";
const BLOCKED = JSON.parse(readFileSync("scripts/blocked-names.json", "utf8")) as string[];
const CARD = `<section class="chart-card" data-frame="Sample"><h2>T</h2>
  <p class="chart-card__meta">Source: S · As of <time datetime="2026-11-03">3 Nov</time>
  · <strong>Sample</strong> · <a href="/methodology/#velocity">Definition</a></p></section>`;

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
};

const realExpected = { ...sampleExpected, kind: "real", frameWord: null };

function page(
  body: string,
  attrs = 'data-dataset-kind="sample" data-dataset-version="20261104T060000Z" data-frame="Sample"',
  title = "[Sample] Open USD Monitor",
  head = '<meta name="robots" content="noindex, nofollow"/>',
) {
  return `<!doctype html><html ${attrs}><head><title>${title}</title>${head}</head><body>
    <header><p>${LINE}</p></header>
    <aside data-dataset-banner>Sample data. Nothing here is real.</aside>
    ${body}
    <footer><p>${LINE}</p><p>Not financial advice.</p>
    <a href="https://example.com/r" rel="noopener noreferrer">Reports</a></footer></body></html>`;
}

const MAIN = `<main><section data-section="verdict"><span>Sample, not a finding</span></section>
  <section data-section="kpi-row"><strong>Sample</strong></section>
  <section data-section="trust-strip">Not reconciled</section>${CARD}</main>`;

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

const realAttrs = 'data-dataset-kind="real" data-dataset-version="20261104T060000Z"';

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

  it("passes a good real site", () => {
    const dir = site({
      main: realPage("<main>Supply reconciled on all 4 chains as of 4 Nov 2026</main>"),
      methodology: realPage("<main>Methodology</main>"),
    });
    expect(verifyOutput(dir, realExpected)).toEqual([]);
  });

  it("fails when a page is missing", () => {
    const dir = tempDir();
    plantFile(dir, "index.html", page(MAIN));
    expect(verifyOutput(dir, sampleExpected)).toContain("methodology/index.html: missing");
  });

  it("fails with no independence line", () => {
    const html = page(MAIN).replaceAll(LINE, "Something else");
    expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
      "index.html: no independence line",
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
        (html: string) => html.replace(' data-frame="Sample"><head>', "><head>"),
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
        (html: string) => html.replace("<strong>Sample</strong> · <a", "<a"),
        'a card has no "Sample" beside its as-of time',
      ],
      [
        "no opinion swap",
        (html: string) => html.replace("Sample, not a finding", "Our reading"),
        '"Our reading" on non-real data',
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
        main: realPage("<main><aside data-dataset-banner>x</aside></main>"),
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
        '<table data-labels-table><tr><td>Coinbase</td></tr></table><p>Morpho, <a href="https://example.com/m" rel="noopener noreferrer">source</a></p>',
      );
      expect(verifyOutput(site({ methodology: sourced }), sampleExpected)).toEqual([]);
      const legend = page(
        "<section data-source-legend><p>The 0x Settler labels rest on this.</p></section>",
      );
      expect(verifyOutput(site({ methodology: legend }), sampleExpected)).toEqual([]);
      const unsourced = page("<p>Coinbase holds this.</p>");
      expect(verifyOutput(site({ methodology: unsourced }), sampleExpected)).toContain(
        'methodology/index.html: names "Coinbase" with no source beside it',
      );
    });

    it("the list has every entity in labels.csv but the issuer", () => {
      const [header, ...rows] = readFileSync("../labels/labels.csv", "utf8").trim().split("\n");
      const column = header.split(",").indexOf("entity");
      const entities = new Set(rows.map((row) => row.split(",")[column]).filter(Boolean));
      entities.delete("Bridge");
      expect(entities.size).toBeGreaterThan(0);
      for (const entity of entities) expect(BLOCKED).toContain(entity);
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
    it.each([
      ["source", "Source: S · ", "a card has no source"],
      ["as-of time", '<time datetime="2026-11-03">3 Nov</time>', "a card has no as-of time"],
      [
        "definition link",
        '<a href="/methodology/#velocity">Definition</a>',
        "a card has no definition link",
      ],
    ])("fails with no %s", (_name, part, problem) => {
      const html = page(MAIN.replace(part, ""));
      expect(verifyOutput(site({ main: html }), sampleExpected)).toContain(
        `index.html: ${problem}`,
      );
    });
  });
});

describe("the Preview frame", () => {
  const preview = { ...sampleExpected, kind: "preview", frameWord: "Preview" };

  it("wants the Preview word, not the Sample one", () => {
    const problems = verifyOutput(site(), preview);
    expect(problems).toContain("index.html: page root says sample, dataset is preview");
    expect(problems).toContain("index.html: no [Preview] in the title");
    expect(problems).toContain('index.html: no "Preview, not a finding"');
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

  it("reads the same dataset the build does", () => {
    const location = locateDataset({ OUSD_DATASET_DIR: "fixtures/dataset/complete" });
    expect(expectedFromDataset(location).version).toBe("20261104T060000Z");
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
