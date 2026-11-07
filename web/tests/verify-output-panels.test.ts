import { describe, expect, it } from "vitest";
import { expectedFromDataset } from "@/scripts/verify-output.mjs";
import { at } from "./dataset-helpers";
import { supplyHarness, WHOLE_PAGE_TIMEOUT_MS } from "./verify-output-panels-fixture";

// The filter, and each supply panel's bars, legend and band. Its figures, notes and tables are in verify-output-supply-figures.test.ts, as one file of both ran out of memory.
describe("the supply panels", { timeout: WHOLE_PAGE_TIMEOUT_MS }, () => {
  const {
    expected,
    main,
    check,
    panelOf,
    inPanel,
    faults,
    S,
    CARD,
    rowOf,
    inRow,
    inCard,
    cardFaults,
    rowFaults,
  } = supplyHarness();
  it("passes the page the dataset calls for, with a bar and a step line per option", () => {
    expect(expected.filter.map(({ label }: { label: string }) => label)).toEqual([
      "All",
      "Tempo",
      "Ethereum",
      "Base",
      "Solana",
    ]);
    expect(expected.supplyPanels).toHaveLength(5);
    expect(expected.seriesPanels).toHaveLength(5);
    expect(check(main)).toEqual([]);
  });

  it("takes the filter's options from the dataset, All covered on partial data", () => {
    const partial = expectedFromDataset(at("fixtures/dataset/partial"));
    expect(partial.filter.map(({ label }: { label: string }) => label)).toEqual([
      "All covered",
      "Tempo",
      "Ethereum",
    ]);
  });

  it("refuses a filter that isn't the dataset's", () => {
    expect(check(main.replace(">All</span>", ">All chains</span>"))).toEqual(
      expect.arrayContaining([expect.stringContaining("the chain filter lists")]),
    );
    expect(
      check(
        main.replace(/<label><input[^>]*value="solana"[^>]*\/><span>Solana<\/span><\/label>/, ""),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("the chain filter lists")]));
    expect(
      check(main.replace('<div class="chain-filter"', '<div hidden class="chain-filter"')),
    ).toContain("index.html: the chain filter isn't in view");
    expect(check(main.replace(" checked/><span>All", "/><span>All"))).toContain(
      "index.html: the chain filter doesn't start on its first option",
    );
  });

  it("refuses a missing bar row, one hidden by its markup, or a bar marked wrong", () => {
    const { start, end } = rowOf(main, "base");
    const gone = `${main.slice(0, start)}${main.slice(end)}`;
    expect(cardFaults(gone)).toEqual(
      expect.arrayContaining([expect.stringContaining(`${CARD}: has bars for`)]),
    );
    const hidden = inRow("base", (row) =>
      row.replace('data-supply-row="base"', 'data-supply-row="base" hidden'),
    );
    expect(rowFaults(hidden, "base")).toContain(`${CARD}, the base bar: it's hidden by its markup`);
    // On Base's card, Tempo's bar not muted, and on All's, a bar marked as chosen.
    const loud = inPanel(
      "base",
      (panel) => panel.replace('data-supply-row="tempo" data-muted', 'data-supply-row="tempo"'),
      S,
    );
    expect(faults(loud, "base")).toContain(
      `index.html: the base panel of #${S}, the tempo bar: it's none, not muted`,
    );
    const marked = inRow("base", (row) =>
      row.replace('data-supply-row="base"', 'data-supply-row="base" data-selected'),
    );
    expect(rowFaults(marked, "base")).toContain(`${CARD}, the base bar: it's selected, not none`);
  });

  // The bug the maintainer found: choosing a chain left every figure at All's. Base's card with All's
  // legend, figures and tables is refused by name, against the dataset's own rows.
  it("refuses a chain's card that shows every chain's figures", () => {
    const allPanel = main.slice(...Object.values(panelOf(main, S, "all")));
    const fromLegend = (html: string) => html.slice(html.indexOf('<ul class="chart-legend"'));
    const allLegend = fromLegend(allPanel);
    const swapped = inPanel(
      "base",
      (panel) => `${panel.slice(0, panel.length - fromLegend(panel).length)}${allLegend}`,
      S,
    );
    expect(swapped).not.toBe(main);
    const base = `index.html: the base panel of #${S}`;
    expect(faults(swapped, "base")).toEqual(
      expect.arrayContaining([
        `${base}: its placed_supply legend amount isn't Base's in the dataset`,
        `${base}: its free_floating legend amount isn't Base's in the dataset`,
        expect.stringContaining(`${base}: its table's chains aren't Base's`),
        `${base}: its named exchanges aren't the dataset's for it`,
      ]),
    );
    expect(check(main)).toEqual([]);
  });

  it("refuses a chain's card that loses its names or says nothing of those left to All", () => {
    const base = `index.html: the base panel of #${S}`;
    const panel = main.slice(...Object.values(panelOf(main, S, "base")));
    const unsplit = /<p data-exchanges-unsplit>.*?<\/p>/.exec(panel)?.[0];
    if (unsplit) {
      const quiet = inPanel("base", (html) => html.replace(unsplit, ""), S);
      expect(faults(quiet, "base")).toContain(
        `${base}: it doesn't say which names aren't split by chain`,
      );
    }
    const lost = inPanel("base", (html) => html.replace(/<li data-exchange-row>.*?<\/li>/, ""), S);
    if (lost !== main) {
      expect(faults(lost, "base")).toContain(
        `${base}: its named exchanges aren't the dataset's for it`,
      );
    }
    expect(Boolean(unsplit) || lost !== main).toBe(true);
  });

  it("refuses a heading or a row's total that isn't the dataset's", () => {
    const heading = inCard((card) => card.replace(/<h2>[^<]*<\/h2>/, "<h2>Another finding.</h2>"));
    expect(cardFaults(heading)).toContain(`${CARD}: its heading isn't the dataset's`);
    const total = inRow("tempo", (row) => row.replace(/(<span data-row-total>)[^<]*/, "$1$9"));
    expect(rowFaults(total, "tempo")).toContain(
      `${CARD}, the tempo bar: its total isn't the dataset's`,
    );
  });

  it("refuses a bar part that isn't the dataset's, or parts that don't add up to total", () => {
    const wrong = inRow("tempo", (html) =>
      html.replace(
        /data-part="placed_supply" data-amount="\d+"/,
        'data-part="placed_supply" data-amount="1"',
      ),
    );
    expect(rowFaults(wrong, "tempo")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("its bar's parts add up to"),
        expect.stringContaining("its bar's placed_supply isn't the dataset's"),
      ]),
    );
  });

  it("refuses a bar drawn at another share", () => {
    const wrong = inRow("tempo", (html) =>
      html.replace(/(data-part="placed_supply"[^>]*flex-basis:)[\d.]+%/, "$190%"),
    );
    expect(rowFaults(wrong, "tempo")).toContain(
      `${CARD}, the tempo bar: its bar's placed_supply isn't drawn at its share`,
    );
  });

  it("refuses a direct label that isn't the dataset's", () => {
    const wrong = inRow("tempo", (html) =>
      html.replace(
        /(data-part="placed_supply"[^>]*><span data-direct-label>)[^<]*/,
        "$1Placed 99%",
      ),
    );
    expect(rowFaults(wrong, "tempo")).toContain(
      `${CARD}, the tempo bar: its bar's placed_supply doesn't carry the dataset's label`,
    );
  });

  it("refuses a band that isn't there, or one drawn where there's none", () => {
    const lost = inRow("ethereum", (html) =>
      html.replace('<span data-testid="exchange-linked-band"></span>', ""),
    );
    expect(rowFaults(lost, "ethereum")).toEqual(
      expect.arrayContaining([expect.stringContaining("its placed_supply band doesn't match")]),
    );
    const added = inRow("tempo", (html) =>
      html.replace(
        /(data-part="placed_supply"[^>]*>)/,
        '$1<span data-testid="exchange-linked-band"></span>',
      ),
    );
    expect(rowFaults(added, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("its placed_supply band doesn't match")]),
    );
  });

  it("refuses a legend that drops a segment or disagrees with the dataset", () => {
    const dropped = inCard((html) =>
      html.replace(/<li data-segment="venue_lending">.*?<\/li>/, ""),
    );
    expect(cardFaults(dropped)).toContain(`${CARD}: its legend doesn't list every segment`);
    const share = inCard((html) =>
      html.replace(/(data-segment="placed_supply">.*?<span data-segment-share>)[^<]*/, "$199.99%"),
    );
    expect(cardFaults(share)).toContain(
      `${CARD}: its placed_supply legend share isn't the dataset's`,
    );
    const amount = inCard((html) =>
      html.replace(/(data-segment="placed_supply">.*?<span data-segment-amount>)[^<]*/, "$1$1"),
    );
    expect(cardFaults(amount)).toContain(
      `${CARD}: its placed_supply legend amount isn't the dataset's`,
    );
  });

  it("refuses an exchange segment that doesn't read as a floor", () => {
    const words = inCard((html) =>
      html.replace(
        /(<li data-segment="venue_exchange"><span data-segment-label>)Exchange venues, at least/,
        "$1Exchange venues",
      ),
    );
    expect(cardFaults(words)).toContain(
      `${CARD}: its venue_exchange legend row doesn't say "Exchange venues, at least"`,
    );
    const mark = inCard((html) => html.replace('<span data-coverage="floor">≥</span>', ""));
    expect(cardFaults(mark)).toEqual(
      expect.arrayContaining([expect.stringContaining("has the wrong coverage mark")]),
    );
  });

  it("refuses a band line that isn't the dataset's", () => {
    const wrong = inCard((html) =>
      html.replace(/(<li data-band="placed_supply"[^>]*>)[^<]*/, "$1Exchange-linked: lots"),
    );
    expect(cardFaults(wrong)).toContain(`${CARD}: its placed_supply band line isn't the dataset's`);
    expect(check(wrong)).toContain(
      "index.html: the exchange-linked line for all isn't the dataset's",
    );
  });
});
