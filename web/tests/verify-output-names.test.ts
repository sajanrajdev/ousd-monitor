import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { locateDataset } from "@/lib/dataset/load";
import { expectedFromDataset, verifyOutput } from "@/scripts/verify-output.mjs";
import { at, copySample, editJson, releaseGrade } from "./dataset-helpers";
import {
  type PlantedBand,
  plantedBands,
  plantedFlight,
  plantedNotes,
  plantedRowFlight,
} from "./planted-first-screen";
import { sampleExpected, page, MAIN, site, mainWith } from "./verify-output-fixture";

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
        text: expect.stringContaining("Base, 2 Nov 2026 UTC: circulating supply moved"),
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

  it("words each caveat from the dataset, and asks for the wallet note in view", () => {
    const dir = releaseGrade();
    editJson(dir, "manifest.json", (manifest) => {
      manifest.definitions.placed_days = 21;
      manifest.definitions.large_transfer_base_units = "2000000000000";
    });
    const notes = expectedFromDataset(at(dir)).essentialNotes as { kind: string; text: string }[];
    const text = (kind: string) => notes.filter((note) => note.kind === kind).map((n) => n.text);
    expect(text("series-start")[0]).toContain("placed supply needs 21 days of history");
    expect(text("everyday-meaning")).toEqual(["Everyday means under $2M, nothing more."]);
    // The supply card's wallet counts are under its toggle, and the note stays in view beside it.
    expect(text("wallets-not-people")).toEqual(["Wallets, not people."]);
    // The weekly bars pin the history; "Weeks end on the date shown" is in their tooltip.
    expect(text("history")[0]).toMatch(/^\d+ days of history: a direction, not a trend\.$/);
  });

  it("recomputes the headings and the KPI values from the dataset", () => {
    const dir = releaseGrade();
    const headings = (expected: ReturnType<typeof expectedFromDataset>) => [
      expected.supplyPanels[0].heading,
      expected.waterfallPanels[0].heading,
      expected.weeklyPanels[0].heading,
    ];
    const before = expectedFromDataset(at(dir));
    // No findings row: each finding is its card's heading, held where the card is.
    expect("findings" in before).toBe(false);
    editJson(dir, "journey.json", (payload) => {
      for (const row of payload.data) {
        const moved = BigInt(row.placed_supply);
        row.placed_supply = "0";
        row.placed_exchange_linked = "0";
        row.free_floating = (BigInt(row.free_floating) + moved).toString();
      }
    });
    const after = expectedFromDataset(at(dir));
    expect(headings(after)[0]).not.toBe(headings(before)[0]);
    expect(headings(after)[0]).toContain("0.00% of supply");
    expect(headings(after).slice(1)).toEqual(headings(before).slice(1));
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
    const floorProps = (children: unknown) =>
      el("li", {
        "data-note": floor.kind,
        children: el("span", { "data-note-text": true, children }),
      });
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
      const line = plantedBands(bands).replace(": $5 (1", ": $9 (1");
      expect(line).not.toBe(plantedBands(bands));
      expect(verifyOutput(mainWith(line), expected)).toContain(
        "index.html: the exchange-linked line for all isn't the dataset's",
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

    it("refuses a chain's own line, as the one legend is the first option's", () => {
      const extra = `<p data-exchange-linked="ethereum">${bands[1].line}</p>`;
      expect(verifyOutput(mainWith(`${plantedBands(bands)}${extra}`), expected)).toContain(
        "index.html: there are 2 exchange-linked lines",
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

describe("a footnote marker", () => {
  it("reads a note's words from the footnote its marker links to, and takes only a number for the marker", () => {
    const floor = { kind: "exchange-floor", text: "A floor.", exact: true };
    const against = { ...sampleExpected, essentialNotes: [floor] };
    const note = (marker: string) =>
      plantedNotes([floor]).replace(/(data-fn-ref="1"[^>]*>)1</, `$1${marker}<`);
    expect(verifyOutput(mainWith(note("2")), against)).toEqual([]);
    expect(verifyOutput(mainWith(note("Added")), against)).toContain(
      "index.html: the exchange-floor note has no marker in view and footnote with its words",
    );
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
