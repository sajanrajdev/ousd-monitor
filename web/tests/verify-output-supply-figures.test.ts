import { describe, expect, it } from "vitest";
import { CARD_ANCHORS } from "@/lib/definitions";
import { PLANTED_WALLETS_CAPTION } from "./planted-first-screen";
import { supplyHarness, WHOLE_PAGE_TIMEOUT_MS } from "./verify-output-panels-fixture";

// Each supply panel's figures, footnotes and tables, and the step line's panels. Split from verify-output-panels.test.ts, as one file of both ran out of memory.
describe(
  "the supply panels' figures, notes and tables, and the step lines",
  { timeout: WHOLE_PAGE_TIMEOUT_MS },
  () => {
    const { main, inPanel, faults, CARD, inRow, inCard, inLegend, cardFaults } = supplyHarness();
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
      expect(cardFaults(unreachable)).toContain(
        `${CARD}: it has no footnotes toggle with its list`,
      );
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
        const marks = /<h2>[^<]*<\/h2>(<sup class="fn-refs" data-fn-refs>.*?<\/sup>)/.exec(
          html,
        )![1];
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
      expect(cardFaults(moved)).toContain(
        `${CARD}: its named exchanges aren't the dataset's for it`,
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
  },
);
