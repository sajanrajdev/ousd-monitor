import { describe, expect, it } from "vitest";
import { CARD_ANCHORS } from "@/lib/definitions";
import { expectedFromDataset, verifyOutput } from "@/scripts/verify-output.mjs";
import { at, editJson, plantFile, releaseGrade, tempDir } from "./dataset-helpers";
import { PLANTED_WALLETS_CAPTION, plantedFlight, plantedRealMain } from "./planted-first-screen";

// In a file of their own, so a worker of their own: each test parses a whole planted main page several
// times, which the heap of a file with hundreds of tests can't also hold. For the same reason they get
// longer than the default, as a slower machine takes seconds over a test with several such pages.
const WHOLE_PAGE_TIMEOUT_MS = 30_000;
const LINE = "Independent. Not affiliated with Open Standard or Bridge.";

function site({ main, methodology }: { main: string; methodology: string }) {
  const dir = tempDir();
  plantFile(dir, "index.html", main);
  plantFile(dir, "methodology/index.html", methodology);
  return dir;
}

describe("the supply panels", { timeout: WHOLE_PAGE_TIMEOUT_MS }, () => {
  const STALE =
    "Data from 4 Nov 2026, 06:00 UTC. Nothing newer has reached this page, so it may be out of date.";
  const TRUST =
    "Last reconciled 4 Nov 2026, 05:30 UTC. Nothing newer has reached this page, so it may be out of date.";
  const location = at(releaseGrade());
  const expected = expectedFromDataset(location);
  const main = plantedRealMain(expected, STALE, TRUST);
  const realPage = (body: string) =>
    `<!doctype html><html data-dataset-kind="real" data-dataset-version="${expected.version}" data-freshness="stale"><head><title>Open USD Monitor</title></head><body>
    <header><p>${LINE}</p></header><p data-stale-note>${STALE}</p>${plantedFlight([])}${body}
    <footer><p>${LINE}</p><p>Not financial advice.</p></footer></body></html>`;
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
  // A fault in one panel, so a right answer in another can't hide it.
  const inPanel = (
    value: string,
    change: (panel: string) => string,
    id: string = CARD_ANCHORS.supply,
  ) => {
    const { start, end } = panelOf(main, id, value);
    return `${main.slice(0, start)}${change(main.slice(start, end))}${main.slice(end)}`;
  };
  const faults = (panel: string, value: string) =>
    check(panel).filter((problem: string) => problem.includes(`the ${value} panel`));

  it("passes the page the dataset calls for, with a panel per option", () => {
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

  it("refuses a missing panel, or one hidden by its markup", () => {
    const { start, end } = panelOf(main, CARD_ANCHORS.supply, "base");
    const gone = `${main.slice(0, start - 5)}${main.slice(end)}`;
    expect(check(gone)).toEqual(
      expect.arrayContaining([expect.stringContaining("#where-supply-sits has panels for")]),
    );
    const hidden = inPanel("base", (panel) =>
      panel.replace('data-chain-panel="base"', 'data-chain-panel="base" hidden'),
    );
    expect(faults(hidden, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("hidden by its markup")]),
    );
  });

  it("refuses another chain's heading, even if All's is right", () => {
    const panel = inPanel("tempo", (html) =>
      html.replace(/<h2>[^<]*<\/h2>/, "<h2>Another finding.</h2>"),
    );
    expect(faults(panel, "tempo")).toContain(
      "index.html: the tempo panel of #where-supply-sits: its heading isn't the dataset's",
    );
  });

  it("refuses a bar part that isn't the dataset's, or parts that don't add up to total", () => {
    const wrong = inPanel("tempo", (html) =>
      html.replace(
        /data-part="placed_supply" data-amount="\d+"/,
        'data-part="placed_supply" data-amount="1"',
      ),
    );
    const problems = faults(wrong, "tempo");
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("its bar's parts add up to"),
        expect.stringContaining("its bar's placed_supply isn't the dataset's"),
      ]),
    );
  });

  it("refuses a bar drawn at another share", () => {
    const wrong = inPanel("tempo", (html) =>
      html.replace(/(data-part="placed_supply"[^>]*flex-basis:)[\d.]+%/, "$190%"),
    );
    expect(faults(wrong, "tempo")).toContain(
      "index.html: the tempo panel of #where-supply-sits: its bar's placed_supply isn't drawn at its share",
    );
  });

  it("refuses a direct label that isn't the dataset's", () => {
    const wrong = inPanel("tempo", (html) =>
      html.replace(
        /(data-part="placed_supply"[^>]*><span data-direct-label>)[^<]*/,
        "$1Placed 99%",
      ),
    );
    expect(faults(wrong, "tempo")).toContain(
      "index.html: the tempo panel of #where-supply-sits: its bar's placed_supply doesn't carry the dataset's label",
    );
  });

  it("refuses a band that isn't there, or one drawn where there's none", () => {
    const lost = inPanel("ethereum", (html) =>
      html.replace('<span data-testid="exchange-linked-band"></span>', ""),
    );
    expect(faults(lost, "ethereum")).toEqual(
      expect.arrayContaining([expect.stringContaining("its placed_supply band doesn't match")]),
    );
    const added = inPanel("tempo", (html) =>
      html.replace(
        /(data-part="placed_supply"[^>]*>)/,
        '$1<span data-testid="exchange-linked-band"></span>',
      ),
    );
    expect(faults(added, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("its placed_supply band doesn't match")]),
    );
  });

  it("refuses a legend that drops a segment or disagrees with the dataset", () => {
    const dropped = inPanel("base", (html) =>
      html.replace(/<li data-segment="venue_lending">.*?<\/li>/, ""),
    );
    expect(faults(dropped, "base")).toContain(
      "index.html: the base panel of #where-supply-sits: its legend doesn't list every segment",
    );
    const share = inPanel("base", (html) =>
      html.replace(/(data-segment="placed_supply">.*?<span data-segment-share>)[^<]*/, "$199.99%"),
    );
    expect(faults(share, "base")).toContain(
      "index.html: the base panel of #where-supply-sits: its placed_supply legend share isn't the dataset's",
    );
    const amount = inPanel("base", (html) =>
      html.replace(/(data-segment="placed_supply">.*?<span data-segment-amount>)[^<]*/, "$1$1"),
    );
    expect(faults(amount, "base")).toContain(
      "index.html: the base panel of #where-supply-sits: its placed_supply legend amount isn't the dataset's",
    );
  });

  it("refuses an exchange segment that doesn't read as a floor", () => {
    const words = inPanel("ethereum", (html) =>
      html.replace("Exchange venues, at least", "Exchange venues"),
    );
    expect(faults(words, "ethereum")).toContain(
      'index.html: the ethereum panel of #where-supply-sits: its venue_exchange legend row doesn\'t say "Exchange venues, at least"',
    );
    const mark = inPanel("ethereum", (html) =>
      html.replace('<span data-coverage="floor">≥</span>', ""),
    );
    expect(faults(mark, "ethereum")).toEqual(
      expect.arrayContaining([expect.stringContaining("has the wrong coverage mark")]),
    );
  });

  it("refuses a band line that isn't the dataset's", () => {
    const wrong = inPanel("tempo", (html) =>
      html.replace(/(<li data-band="placed_supply"><span[^>]*>)[^<]*/, "$1Exchange-linked: lots"),
    );
    expect(faults(wrong, "tempo")).toContain(
      "index.html: the tempo panel of #where-supply-sits: its placed_supply band line isn't the dataset's",
    );
  });

  it("refuses a wallet total under All, and a chain without its wallets", () => {
    const total = inPanel("all", (html) =>
      html.replace(
        "</dl>",
        '<div data-stat="active-wallets"><dt>Active wallets</dt><dd data-stat-value>1,200</dd></div></dl>',
      ),
    );
    expect(faults(total, "all")).toEqual(
      expect.arrayContaining([expect.stringContaining("beside the bar")]),
    );
    const none = inPanel("base", (html) =>
      html.replace(/<div data-stat="active-wallets">.*?<\/div>/, ""),
    );
    expect(faults(none, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("beside the bar")]),
    );
    const figure = inPanel("base", (html) =>
      html.replace(/(data-stat="clean-7d"><dt>[^<]*<\/dt><dd data-stat-value>)[^<]*/, "$1$9"),
    );
    expect(faults(figure, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("its clean-7d isn't the dataset's")]),
    );
  });

  it("holds the figures and wallet table to the KPI rows, and refuses wallets across chains", () => {
    const loose = inPanel("all", (html) =>
      html.replace("</dl>", "</dl><p>Active wallets, 7 days: 1,740</p>"),
    );
    expect(faults(loose, "all")).toContain(
      "index.html: the all panel of #where-supply-sits: it shows a wallet figure across chains",
    );
    const figure = inPanel("all", (html) =>
      html.replace(/(data-stat="circulating"><dt>[^<]*<\/dt><dd data-stat-value>)[^<]*/, "$1$9"),
    );
    expect(faults(figure, "all")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("its circulating disagrees with the KPI rows"),
      ]),
    );
    const wallets = inPanel("tempo", (html) =>
      html.replace(/(<td data-label="Active wallets, 7 days">)[^<]*/, "$1999999"),
    );
    expect(faults(wallets, "tempo")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("its table's Active wallets, 7 days isn't the dataset's"),
      ]),
    );
  });

  it("refuses a caveat lost from one panel, hidden, reworded or for another chain", () => {
    const lost = inPanel("tempo", (html) =>
      html.replace(/<li data-note="exchange-floor">.*?<\/li>/, ""),
    );
    expect(faults(lost, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("its notes are")]),
    );
    const folded = inPanel("tempo", (html) =>
      html.replace(
        /(<li data-note="exchange-floor">)(.*?)(<\/li>)/,
        "$1<details><summary>More</summary>$2</details>$3",
      ),
    );
    expect(faults(folded, "tempo")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exchange-floor note doesn't keep its words"),
      ]),
    );
    const reworded = inPanel("tempo", (html) =>
      html.replace("Exchange venues are a floor", "Exchange venues are about right"),
    );
    expect(faults(reworded, "tempo")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exchange-floor note doesn't keep its words"),
      ]),
    );
    const other = inPanel("base", (html) =>
      html.replace(
        '<li data-note="placed">',
        '<li data-note="exchange-coverage" data-chain="tempo"><span class="pin">9</span><p>Tempo: no wallet.</p></li><li data-note="placed">',
      ),
    );
    expect(faults(other, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("its notes are")]),
    );
  });

  it("refuses a note with the wrong number, and a legend pin that points elsewhere", () => {
    const note = inPanel("base", (html) =>
      html.replace(
        '<span class="pin" aria-hidden="true">1</span>',
        '<span class="pin" aria-hidden="true">7</span>',
      ),
    );
    expect(faults(note, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("has the wrong number")]),
    );
    const pin = inPanel("base", (html) =>
      html.replace(/(data-segment="placed_supply">.*?<span class="pin">)\d+/, "$14"),
    );
    expect(faults(pin, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("placed_supply legend row points at notes")]),
    );
  });

  it("refuses a popover that has lost the full note", () => {
    const panel = inPanel("base", (html) =>
      html.replace(/<p data-full-note="placed">.*?<\/p>/, ""),
    );
    expect(faults(panel, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("lost the placed note in full")]),
    );
  });

  it("refuses a table row that isn't the dataset's, or a table with another chain's rows", () => {
    const cell = inPanel("base", (html) => html.replace(/(<td data-label="Total">)[^<]*/, "$1$9"));
    expect(faults(cell, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("its table's Total isn't the dataset's")]),
    );
    const extra = inPanel("base", (html) =>
      html.replace("</tbody>", "<tr><td>Tempo</td></tr></tbody>"),
    );
    expect(faults(extra, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("its table has 2 rows, not 1")]),
    );
  });

  it("refuses a wallet table that doesn't say what a wallet is", () => {
    const panel = inPanel("base", (html) =>
      html.replace(`Last 7 days. ${PLANTED_WALLETS_CAPTION}`, "Last 7 days."),
    );
    expect(faults(panel, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("doesn't say what a wallet is")]),
    );
  });

  it("refuses exchange rows that left All's toggle", () => {
    const moved = main.replace("<div data-labels-table>", "<div>");
    expect(faults(moved, "all")).toEqual(
      expect.arrayContaining([expect.stringContaining("exchange rows under its toggle")]),
    );
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
    const note = inPanel(
      "tempo",
      (html) => html.replace("<p>The series starts", "<p>The line starts"),
      id,
    );
    expect(faults(note, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("series-start note doesn't keep its words")]),
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
    const figure = inPanel(
      "tempo",
      (html) => html.replace(/(<span data-series-value>)[^<]*/, "$1$9"),
      id,
    );
    expect(faults(figure, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("legend's figures aren't the newest day's")]),
    );
  });
});

describe("the activity panels", { timeout: WHOLE_PAGE_TIMEOUT_MS }, () => {
  const STALE =
    "Data from 4 Nov 2026, 06:00 UTC. Nothing newer has reached this page, so it may be out of date.";
  const TRUST =
    "Last reconciled 4 Nov 2026, 05:30 UTC. Nothing newer has reached this page, so it may be out of date.";
  const expected = expectedFromDataset(at(releaseGrade()));
  const main = plantedRealMain(expected, STALE, TRUST);
  const page = (body: string) =>
    `<!doctype html><html data-dataset-kind="real" data-dataset-version="${expected.version}" data-freshness="stale"><head><title>Open USD Monitor</title></head><body>
    <header><p>${LINE}</p></header><p data-stale-note>${STALE}</p>${plantedFlight([])}${body}
    <footer><p>${LINE}</p><p>Not financial advice.</p></footer></body></html>`;
  const check = (body: string) =>
    verifyOutput(site({ main: page(body), methodology: page("<main>Fine</main>") }), expected);
  const inPanel = (id: string, value: string, change: (panel: string) => string) => {
    const box = main.indexOf(`id="${id}"`);
    const start = main.indexOf(`data-chain-panel="${value}"`, box);
    const ends = [
      main.indexOf('<div data-chain-panel="', start + 1),
      main.indexOf('<div id="', start),
    ];
    const end = Math.min(...ends.filter((at) => at !== -1));
    return `${main.slice(0, start)}${change(main.slice(start, end))}${main.slice(end)}`;
  };
  const faults = (body: string, id: string, value: string) =>
    check(body).filter((problem: string) => problem.includes(`the ${value} panel of #${id}`));
  const W = CARD_ANCHORS.waterfall;
  const K = CARD_ANCHORS.weekly;

  it("passes the page the dataset calls for, with a panel per option for both cards", () => {
    expect(expected.waterfallPanels).toHaveLength(5);
    expect(expected.weeklyPanels).toHaveLength(5);
    expect(check(main)).toEqual([]);
  });

  it("pins the small-ticket note under All and Tempo, and no other chain", () => {
    const kinds = (value: string) =>
      expected.waterfallPanels
        .find((panel: { value: string }) => panel.value === value)!
        .notes.map((note: { kind: string }) => note.kind);
    expect(kinds("all")).toContain("small-ticket");
    expect(kinds("tempo")).toContain("small-ticket");
    for (const value of ["ethereum", "base", "solana"]) {
      expect(kinds(value)).not.toContain("small-ticket");
    }
  });

  it("refuses a waterfall panel that isn't the dataset's", () => {
    const heading = inPanel(W, "base", (html) =>
      html.replace(/<h2>[^<]*<\/h2>/, "<h2>Other.</h2>"),
    );
    expect(faults(heading, W, "base")).toContain(
      `index.html: the base panel of #${W}: its heading isn't the dataset's`,
    );
    const figure = inPanel(W, "base", (html) =>
      html.replace(/(<li data-step="burned">.*?<span class="tabular-nums">)[^<]*/, "$1−$9"),
    );
    expect(faults(figure, W, "base")).toEqual(
      expect.arrayContaining([expect.stringContaining("its rows aren't the dataset's")]),
    );
    const pin = inPanel(W, "tempo", (html) =>
      html.replace(/(<li data-step="clean_large"><span>S)(<span class="pin">\d+<\/span>)/, "$1"),
    );
    expect(faults(pin, W, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("its pins are")]),
    );
    const lost = inPanel(W, "tempo", (html) =>
      html.replace(/<li data-note="small-ticket">.*?<\/li>/, ""),
    );
    expect(faults(lost, W, "tempo")).toEqual(
      expect.arrayContaining([expect.stringContaining("its notes are")]),
    );
    const full = inPanel(W, "all", (html) =>
      html.replace(/<p data-full-note="small-ticket">.*?<\/p>/, ""),
    );
    expect(faults(full, W, "all")).toEqual(
      expect.arrayContaining([expect.stringContaining("lost the small-ticket note in full")]),
    );
    const cell = inPanel(W, "base", (html) =>
      html.replace(/(<td data-label="Clean large">)[^<]*/, "$1$9"),
    );
    expect(faults(cell, W, "base")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("its table's Clean large isn't the dataset's"),
      ]),
    );
  });

  it("refuses a weekly panel that isn't the dataset's", () => {
    const bar = inPanel(K, "solana", (html) =>
      html.replace(/(<span data-week-value>)[^<]*/, "$1$9"),
    );
    expect(faults(bar, K, "solana")).toEqual(
      expect.arrayContaining([expect.stringContaining("its bars aren't the dataset's")]),
    );
    const pins = inPanel(K, "solana", (html) =>
      html.replace(/<div data-chart-pins>.*?<\/div>/, "<div data-chart-pins></div>"),
    );
    expect(faults(pins, K, "solana")).toEqual(
      expect.arrayContaining([expect.stringContaining("its pins don't match its notes")]),
    );
    const note = inPanel(K, "solana", (html) => html.replace("nothing more.", "or so."));
    expect(faults(note, K, "solana")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("everyday-meaning note doesn't keep its words"),
      ]),
    );
    const marker = inPanel(K, "solana", (html) =>
      html.replace(
        /(<li data-note="history"><span class="pin" aria-hidden="true">\d+<\/span><p>)/,
        '$1<span class="status-chip" data-kind="fact">F</span> ',
      ),
    );
    expect(faults(marker, K, "solana")).toEqual(
      expect.arrayContaining([expect.stringContaining("history note's marker isn't absent")]),
    );
    const hidden = inPanel(K, "solana", (html) =>
      html.replace(
        /<ol data-pinned-notes>/,
        "<details><summary>More</summary><ol data-pinned-notes>",
      ),
    );
    expect(check(hidden).length).toBeGreaterThan(0);
  });
});

describe("the velocity chart and the chain grid", { timeout: WHOLE_PAGE_TIMEOUT_MS }, () => {
  const STALE =
    "Data from 4 Nov 2026, 06:00 UTC. Nothing newer has reached this page, so it may be out of date.";
  const TRUST =
    "Last reconciled 4 Nov 2026, 05:30 UTC. Nothing newer has reached this page, so it may be out of date.";
  const dir = releaseGrade();
  editJson(dir, "manifest.json", (manifest) => {
    manifest.warnings = [
      {
        chain: "base",
        metric: "circulating_supply",
        day: "2026-11-02",
        previous: "20000000000000",
        current: "10000000000000",
      },
    ];
  });
  const expected = expectedFromDataset(at(dir));
  const main = plantedRealMain(expected, STALE, TRUST);
  const page = (body: string) =>
    `<!doctype html><html data-dataset-kind="real" data-dataset-version="${expected.version}" data-freshness="stale"><head><title>Open USD Monitor</title></head><body>
    <header><p>${LINE}</p></header><p data-stale-note>${STALE}</p>${plantedFlight([])}${body}
    <footer><p>${LINE}</p><p>Not financial advice.</p></footer></body></html>`;
  const check = (body: string) =>
    verifyOutput(site({ main: page(body), methodology: page("<main>Fine</main>") }), expected);

  it("passes the page the dataset calls for, with the warning pinned beside its chain", () => {
    expect(expected.velocity.notes[0]).toMatchObject({ kind: "velocity-warning", chain: "base" });
    expect(check(main)).toEqual([]);
  });

  it("fails with the warning only in the popover, or its pin on another chain", () => {
    const moved = main.replace(/<li data-note="velocity-warning".*?<\/li>/, "");
    expect(check(moved)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "#velocity-by-chain: its notes are velocity-denominators:, not velocity-warning:base,",
        ),
      ]),
    );
    const elsewhere = main
      .replace(/(<p class="velocity-chart__name">base)<span class="pin">1<\/span>/, "$1")
      .replace(/(<p class="velocity-chart__name">tempo)/, '$1<span class="pin">1</span>');
    expect(check(elsewhere)).toEqual(
      expect.arrayContaining([expect.stringContaining("its chain pins are tempo=1, not base=1")]),
    );
  });

  it("fails on a bar that isn't the dataset's, or a caption that drops wallets, not people", () => {
    const bar = main.replace(/(<span data-velocity-value>)[^<]*/, "$19.99%");
    expect(check(bar)).toEqual(
      expect.arrayContaining([expect.stringContaining("its bars aren't the dataset's")]),
    );
    const caption = main.replace("Velocity. Wallets, not people.", "Velocity.");
    expect(check(caption)).toEqual(
      expect.arrayContaining([expect.stringContaining("doesn't say what a wallet is")]),
    );
  });

  it("fails when the popover loses a full note, or the denominators pin leaves its legend entry", () => {
    const full = main.replace(/<p data-full-note="velocity-denominators">.*?<\/p>/, "");
    expect(check(full)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lost the velocity-denominators note in full"),
      ]),
    );
    const pin = main.replace(/(Headline velocity)<span class="pin">\d+<\/span>/, "$1");
    expect(check(pin)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("the denominators pin isn't on the headline velocity legend"),
      ]),
    );
  });

  it("fails on a grid cell, bar or lead marker that isn't the dataset's", () => {
    const cell = main.replace(/(<span data-grid-value>)[^<]*/, "$19.99%");
    const lead = main.replace(/ data-leads>/, ">");
    const width = main.replace(/(chain-grid__bar" data-width=")\d+/, "$1123");
    for (const body of [cell, lead, width]) {
      expect(check(body)).toEqual(
        expect.arrayContaining([expect.stringContaining("its grid isn't the dataset's")]),
      );
    }
  });
});
