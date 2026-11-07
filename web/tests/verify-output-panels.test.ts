import { describe, expect, it } from "vitest";
import { CARD_ANCHORS } from "@/lib/definitions";
import { expectedFromDataset, verifyOutput } from "@/scripts/verify-output.mjs";
import { at, plantFile, releaseGrade, tempDir } from "./dataset-helpers";
import {
  PLANTED_WALLETS_CAPTION,
  plantedFlight,
  plantedFooter,
  plantedRealMain,
  plantedReconciliationMain,
  PLANTED_HEADER,
  plantedBack,
} from "./planted-first-screen";

// In a file of their own, so a worker of their own: each test parses a whole planted main page several
// times, which the heap of a file with hundreds of tests can't also hold. For the same reason they get
// longer than the default, as a slower machine takes seconds over a test with several such pages.
const WHOLE_PAGE_TIMEOUT_MS = 30_000;
// The release-grade copy, long past its 36 hours, so its detail page states its last run as old.
const RECONCILED_TRUST =
  "Last run 4 Nov 2026, 05:30 UTC: every check passed. Nothing newer has reached this page, so it may be out of date.";

function site({ main, methodology }: { main: string; methodology: string }) {
  const dir = tempDir();
  plantFile(dir, "index.html", main);
  plantFile(dir, "methodology/index.html", plantedBack(methodology));
  plantFile(
    dir,
    "reconciliation/index.html",
    methodology.replace("<main>Fine</main>", plantedReconciliationMain(RECONCILED_TRUST)),
  );
  return dir;
}

describe("the supply panels", { timeout: WHOLE_PAGE_TIMEOUT_MS }, () => {
  const TRUST =
    "Last reconciled 4 Nov 2026, 05:30 UTC. Nothing newer has reached this page, so it may be out of date.";
  const location = at(releaseGrade());
  const expected = expectedFromDataset(location);
  const main = plantedRealMain(expected, TRUST);
  const realPage = (body: string) =>
    `<!doctype html><html data-dataset-kind="real" data-dataset-version="${expected.version}" data-freshness="stale"><head><title>Open USD Monitor</title></head><body>
    ${PLANTED_HEADER}${plantedFlight([])}${body}
    ${plantedFooter(false, { fresh: null, stale: TRUST, short: "Last reconciled 4 Nov" })}</body></html>`;
  const check = (body: string, against = expected) =>
    verifyOutput(
      site({ main: realPage(body), methodology: realPage("<main>Fine</main>") }),
      against,
    );
  const panelOf = (html: string, id: string, value: string) => {
    const box = html.indexOf(`id="${id}"`);
    const start = html.indexOf(`data-chain-panel="${value}"`, box);
    const next = html.indexOf('<div data-chain-panel="', start + 1);
    const close = html.indexOf('<div id="', start);
    const end = Math.min(...[next, close].filter((at) => at !== -1));
    return { start, end };
  };
  // A fault in one of the step line's panels, so a right answer in another can't hide it.
  const inPanel = (value: string, change: (panel: string) => string, id: string) => {
    const { start, end } = panelOf(main, id, value);
    return `${main.slice(0, start)}${change(main.slice(start, end))}${main.slice(end)}`;
  };
  const faults = (panel: string, value: string) =>
    check(panel).filter((problem: string) => problem.includes(`the ${value} panel`));
  // The supply card has a panel per option, each with every option's bar: a fault in one of All's
  // bar rows, or in All's card around them. A chain's panel is changed with inPanel.
  const S = CARD_ANCHORS.supply;
  const CARD = `index.html: the all panel of #${S}`;
  const rowOf = (html: string, value: string) => {
    const start = html.indexOf(`<div data-supply-row="${value}"`, html.indexOf(`id="${S}"`));
    const ends = [
      html.indexOf("<div data-supply-row=", start + 1),
      html.indexOf("data-supply-legend", start),
    ];
    return { start, end: Math.min(...ends.filter((at) => at !== -1)) };
  };
  const inRow = (value: string, change: (row: string) => string) => {
    const { start, end } = rowOf(main, value);
    return `${main.slice(0, start)}${change(main.slice(start, end))}${main.slice(end)}`;
  };
  const inCard = (change: (card: string) => string) => inPanel("all", change, S);
  // A change from the legend on, which takes in the card's footnotes after its as-of line.
  const inLegend = (change: (legend: string) => string) =>
    inCard((html) => {
      const at = html.indexOf("data-supply-legend");
      return `${html.slice(0, at)}${change(html.slice(at))}`;
    });
  const cardFaults = (body: string) =>
    check(body).filter((problem: string) => problem.startsWith(CARD));
  const rowFaults = (body: string, value: string) =>
    check(body).filter((problem: string) => problem.startsWith(`${CARD}, the ${value} bar`));

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

  it("refuses a wallet total, and a figure that isn't the dataset's", () => {
    const total = inCard((html) =>
      html.replace(
        "</dl>",
        '<div data-stat="active-wallets"><dt>Active wallets</dt><dd data-stat-value>1,200</dd></div></dl>',
      ),
    );
    expect(cardFaults(total)).toEqual(
      expect.arrayContaining([expect.stringContaining("beside the bar")]),
    );
    const figure = inCard((html) =>
      html.replace(/(data-stat="clean-7d"><dt>[^<]*<\/dt><dd data-stat-value>)[^<]*/, "$1$9"),
    );
    expect(cardFaults(figure)).toContain(`${CARD}: its clean-7d isn't the dataset's`);
  });

  it("holds the figures and wallet table to the KPI rows, and refuses wallets across chains", () => {
    const loose = inCard((html) =>
      html.replace("</dl>", "</dl><p>Active wallets, 7 days: 1,740</p>"),
    );
    expect(cardFaults(loose)).toContain(`${CARD}: it shows a wallet figure across chains`);
    const inRowToo = inRow("tempo", (html) =>
      html.replace("</p>", " · <span>300 active wallets</span></p>"),
    );
    expect(cardFaults(inRowToo)).toContain(`${CARD}: it shows a wallet figure across chains`);
    const figure = inCard((html) =>
      html.replace(/(data-stat="circulating"><dt>[^<]*<\/dt><dd data-stat-value>)[^<]*/, "$1$9"),
    );
    expect(cardFaults(figure)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("its circulating disagrees with the KPI rows"),
      ]),
    );
    const wallets = inCard((html) =>
      html.replace(/(<td data-label="Active wallets, 7 days">)[^<]*/, "$1999999"),
    );
    expect(cardFaults(wallets)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("its table's Active wallets, 7 days isn't the dataset's"),
      ]),
    );
  });

  it("refuses a caveat lost, out of reach, reworded, without its marker, or for another chain", () => {
    const lost = inLegend((html) =>
      html.replace(/<li id="[^"]*" data-note="exchange-floor">.*?<\/li>/, ""),
    );
    expect(lost).not.toBe(main);
    expect(cardFaults(lost)).toEqual(
      expect.arrayContaining([expect.stringContaining("its footnotes are")]),
    );
    // A list with no "Footnotes" toggle can't be opened by keyboard or without a script.
    const unreachable = inCard((html) =>
      html.replace("<summary>Footnotes</summary>", "<summary>More</summary>"),
    );
    expect(unreachable).not.toBe(main);
    expect(cardFaults(unreachable)).toContain(`${CARD}: it has no footnotes toggle with its list`);
    const reworded = inLegend((html) =>
      html.replace("Exchange venues are a floor.", "Exchange venues are about right."),
    );
    expect(cardFaults(reworded)).toContain(
      `${CARD}: its exchange-floor footnote doesn't keep its words`,
    );
    // A footnote with no marker to point at it is the caveat lost from what it qualifies.
    const unmarked = inLegend((html) =>
      html.replace(
        /(data-segment="placed_supply"><span data-segment-label>[^<]*<\/span>)<sup class="fn-refs" data-fn-refs>.*?<\/sup>/,
        "$1",
      ),
    );
    expect(unmarked).not.toBe(main);
    expect(cardFaults(unmarked)).toEqual(
      expect.arrayContaining([expect.stringContaining("its placed footnote hasn't one marker")]),
    );
    // And the note in full, in the same footnote, keeps its words too.
    const full = inLegend((html) =>
      html.replace(
        /(<li id="[^"]*" data-note="placed">.*?<span data-note-full>)[^<]*/,
        "$1Placed is fine.",
      ),
    );
    expect(full).not.toBe(main);
    expect(cardFaults(full)).toContain(`${CARD}: its placed footnote has lost its words in full`);
    const other = inLegend((html) =>
      html.replace(
        /<li id="[^"]*" data-note="placed">/,
        '<li id="other" data-note="exchange-coverage" data-chain="base">Base.</li>$&',
      ),
    );
    expect(cardFaults(other)).toEqual(
      expect.arrayContaining([expect.stringContaining("its footnotes are")]),
    );
  });

  it("refuses a marker with the wrong number, one moved off what it qualifies, or a second set", () => {
    const note = inCard((html) => html.replace(/(data-fn-ref="1"[^>]*>)1</, "$17<"));
    expect(note).not.toBe(main);
    expect(cardFaults(note)).toEqual(
      expect.arrayContaining([expect.stringContaining("hasn't one marker numbered 1")]),
    );
    // The placed marker moved to the DEX row, which keeps the order but points at another row.
    const moved = inLegend((html) => {
      const marker =
        /(data-segment="placed_supply"><span data-segment-label>[^<]*<\/span>)(<sup class="fn-refs" data-fn-refs>.*?<\/sup>)/.exec(
          html,
        )!;
      return html
        .replace(marker[0], marker[1])
        .replace(
          /(data-segment="venue_dex"><span data-segment-label>[^<]*<\/span>)/,
          `$1${marker[2]}`,
        );
    });
    expect(moved).not.toBe(main);
    expect(cardFaults(moved)).toContain(`${CARD}: its placed marker isn't on placed_supply`);
    // The title's marker again at the foot of the card is a second set of markers.
    const twice = inCard((html) => {
      const marks = /<h2>[^<]*<\/h2>(<sup class="fn-refs" data-fn-refs>.*?<\/sup>)/.exec(html)![1];
      return html.replace('<p class="chart-card__meta">', `<p>${marks}</p>$&`);
    });
    expect(twice).not.toBe(main);
    expect(cardFaults(twice)).toEqual(
      expect.arrayContaining([expect.stringContaining("footnote markers for")]),
    );
  });

  it("refuses a tooltip that has lost the full note", () => {
    const card = inCard((html) => html.replace(/<p data-full-note="placed">.*?<\/p>/, ""));
    expect(cardFaults(card)).toContain(`${CARD}: its tooltip has lost the placed note in full`);
  });

  it("refuses a table row that isn't the dataset's, or a table with a row too many", () => {
    const cell = inCard((html) => html.replace(/(<td data-label="Total">)[^<]*/, "$1$9"));
    expect(cardFaults(cell)).toEqual(
      expect.arrayContaining([expect.stringContaining("its table's Total isn't the dataset's")]),
    );
    const extra = inCard((html) => html.replace("</tbody>", "<tr><td>Tempo</td></tr></tbody>"));
    expect(cardFaults(extra)).toEqual(
      expect.arrayContaining([expect.stringContaining("its table has 5 rows, not 4")]),
    );
  });

  it("refuses a wallet table that doesn't say what a wallet is", () => {
    const card = inCard((html) =>
      html.replace(`Last 7 days. ${PLANTED_WALLETS_CAPTION}`, "Last 7 days."),
    );
    expect(cardFaults(card)).toContain(
      `${CARD}: its table of wallets doesn't say what a wallet is`,
    );
  });

  it("refuses exchange rows that left the card's toggle", () => {
    const moved = inCard((html) => html.replace("<div data-labels-table>", "<div>"));
    expect(cardFaults(moved)).toContain(`${CARD}: its named exchanges aren't the dataset's for it`);
  });

  it("refuses a step line panel that isn't the dataset's", () => {
    const id = CARD_ANCHORS.series;
    const heading = inPanel(
      "tempo",
      (html) => html.replace(/<h2>[^<]*<\/h2>/, "<h2>Another.</h2>"),
      id,
    );
    expect(faults(heading, "tempo")).toContain(
      "index.html: the tempo panel of #placed-vs-circulating: its heading isn't the dataset's",
    );
    const note = inPanel("tempo", (html) => html.replace(">Starts ", ">Began "), id);
    expect(faults(note, "tempo")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("series-start footnote doesn't keep its words"),
      ]),
    );
    const full = inPanel(
      "tempo",
      (html) => html.replace(/<p data-full-note="series-start">.*?<\/p>/, ""),
      id,
    );
    expect(faults(full, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("lost the series note in full")]),
    );
    const cell = inPanel(
      "tempo",
      (html) => html.replace(/(<td data-label="Placed">)[^<]*/, "$1$9"),
      id,
    );
    expect(faults(cell, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("its table's Placed isn't the dataset's")]),
    );
    // Its legend names the lines; their newest figures are the supply card's and the table's.
    const legend = inPanel(
      "tempo",
      (html) =>
        html.replace("<li data-series-line>Circulating</li>", "<li data-series-line>Other</li>"),
      id,
    );
    expect(faults(legend, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("its legend doesn't name Total")]),
    );
  });
});
