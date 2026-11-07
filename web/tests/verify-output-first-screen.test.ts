import { describe, expect, it } from "vitest";
import { expectedFromDataset, verifyOutput } from "@/scripts/verify-output.mjs";
import { at, markStale, releaseGrade } from "./dataset-helpers";
import {
  PLANTED_TRUST_CAVEAT,
  PLANTED_TRUST_LINK,
  PLANTED_VERDICT,
  plantedFooter,
  plantedNotes,
  plantedNotesFlight,
  plantedReconciliationMain,
  plantedTip,
  PLANTED_BACK,
} from "./planted-first-screen";
import {
  LINE,
  STALE_NOTE,
  STALE_TRUST,
  SHORT_TRUST,
  FRESH_TRUST,
  HEAD_STALE,
  SAMPLE_RUN,
  sampleExpected,
  realExpected,
  freshRealExpected,
  REPORTS,
  SAMPLE_FOOTER,
  REAL_FOOTER,
  FRESH_FOOTER,
  page,
  MAIN,
  site,
  mainWith,
  REAL_MAIN,
  FRESH_MAIN,
  realPage,
  freshPage,
} from "./verify-output-fixture";

describe("the first screen", () => {
  const change = (from: string, to: string) => (html: string) => {
    expect(html).toContain(from);
    return html.replaceAll(from, to);
  };
  const inDetails = (inner: string) => `<details><summary>More</summary>${inner}</details>`;
  const inTooltip = (inner: string) => plantedTip("More", inner);
  const VERDICT_TEXT = "<span data-verdict-text>The verdict's text, 12% &amp; more.</span>";

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
      "the headline in a tooltip",
      change("<h1>A headline.</h1>", inTooltip("<h1>A headline.</h1>")),
      "the headline isn't the verdict's sentence",
    ],
    [
      "the question line back above the headline",
      change(
        '<div class="verdict-block__head">',
        '<p data-section="question">A question?</p><div class="verdict-block__head">',
      ),
      "the question line is back above the headline",
    ],
    [
      "verdict.text in a details on a dataset that keeps it in view",
      change(`<p>${VERDICT_TEXT}</p>`, inDetails(`<p>${VERDICT_TEXT}</p>`)),
      "verdict.text isn't in view on this dataset",
    ],
    [
      "verdict.text in a tooltip on a dataset that keeps it in view",
      change(`<p>${VERDICT_TEXT}</p>`, `<p>${inTooltip(VERDICT_TEXT)}</p>`),
      "verdict.text isn't in view on this dataset",
    ],
    [
      "verdict.text visually hidden",
      change("<span data-verdict-text>", '<span class="sr-only" data-verdict-text>'),
      "verdict.text isn't in view on this dataset",
    ],
    [
      "verdict.text reworded",
      change("The verdict's text, 12%", "The verdict's text, about 12%"),
      "verdict.text isn't in view on this dataset",
    ],
    [
      "a verdict item lost from the tooltip",
      change("<p>An estimate.</p>", ""),
      "the headline's tooltip has lost a verdict item",
    ],
    [
      "no definition link in the headline's tooltip",
      change('<a href="/methodology/#verdict">How the reading is made</a>', ""),
      "the headline's tooltip has no definition link",
    ],
    [
      "a KPI cell gone",
      (html: string) => html.replace(/<dl><div>[\s\S]*?<\/div><\/div>/, "<dl>"),
      "the KPI row has 3 cells",
    ],
    [
      "a KPI value gone",
      change("<span data-kpi-value>$1</span>", ""),
      "a KPI has no value in view",
    ],
    [
      "a KPI value only in its tooltip",
      change(
        "<span data-kpi-value>$1</span>",
        `<span>${inTooltip("<span data-kpi-value>$1</span>")}</span>`,
      ),
      "a KPI has no value in view",
    ],
    [
      "a KPI with no note",
      change("<p data-kpi-note>A note.</p>", "<p>As of 3 Nov.</p>"),
      "a KPI's tooltip has no note",
    ],
    [
      "a KPI with no definition link",
      change(
        '<p data-kpi-note>A note.</p><a href="/methodology/#velocity">Definition</a>',
        "<p data-kpi-note>A note.</p>",
      ),
      "a KPI's tooltip has no definition link",
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
      change("<p data-kpi-scope>Across Tempo.</p>", inDetails("<p>Across Tempo.</p>")),
      "the KPI row doesn't say which chains it covers",
    ],
    [
      "the KPI row's chains in a tooltip",
      change("<p data-kpi-scope>Across Tempo.</p>", `<p>${inTooltip("Across Tempo.")}</p>`),
      "the KPI row doesn't say which chains it covers",
    ],
    [
      "a marker back on a KPI",
      change(
        "<span data-kpi-value>$1</span>",
        '<span data-kpi-value>$1</span><span class="status-chip" data-kind="fact">F</span>',
      ),
      "a marker is back on the main page",
    ],
    [
      "the marker legend back",
      change(
        '<section data-section="kpi-row">',
        '<div data-section="marker-legend"><p>F Fact</p></div><section data-section="kpi-row">',
      ),
      "a marker is back on the main page",
    ],
    [
      "a push-down popover back on the first screen",
      change(
        '<section data-section="kpi-row">',
        '<details class="info-popover"><summary aria-label="About"></summary><p>A note.</p></details><section data-section="kpi-row">',
      ),
      "an explanation pushes the page down, in a details element",
    ],
    [
      "the trust row's disclosure back",
      change(
        PLANTED_TRUST_LINK,
        `<details class="accordion"><summary>Reconciliation detail</summary><p>${PLANTED_TRUST_CAVEAT}</p></details>`,
      ),
      "an explanation pushes the page down, in a details element",
    ],
    [
      "the trust row gone on a build that didn't pass",
      (html: string) => html.replace(/<section data-section="trust-strip">[\s\S]*?<\/section>/, ""),
      "the trust row isn't at the top on sample, preview or a failed run",
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
      "index.html: verdict.text is neither in view nor in its tooltip",
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

    it("passes with each one's marker in view, and its words in the card's footnotes", () => {
      expect(verifyOutput(mainWith(plantedNotes(notes)), expected)).toEqual([]);
    });

    it.each([
      ["gone", () => ""],
      ["in a popover", (note: string) => inDetails(note)],
      ["in a noscript", (note: string) => `<noscript>${note}</noscript>`],
      ["with its marker hidden", (note: string) => note.replace("<a href=", "<a hidden href=")],
      [
        "with its marker visually hidden",
        (note: string) => note.replace('class="fn-ref"', 'class="fn-ref sr-only"'),
      ],
      ["with its markers hidden", (note: string) => note.replace("<sup ", "<sup hidden ")],
      ["with no marker", (note: string) => note.replace(/<a [^>]*data-fn-ref[^>]*>\d+<\/a>/, "")],
      [
        "with its words outside its footnote",
        (note: string) =>
          note.replace(
            /(<span data-note-text>.*?<\/span>)(.*?<\/details>)/,
            "<span data-note-text></span>$2$1",
          ),
      ],
      ["empty", (note: string) => note.replace("A dated warning.", "")],
    ])("fails on a note %s", (_name, hide) => {
      const body =
        plantedNotes([notes[0]]) + hide(plantedNotes([notes[1]])) + plantedNotesFlight(notes);
      // A card in a details or a noscript, or a marker gone, fails other checks as well.
      expect(verifyOutput(mainWith(body), expected)).toContain(
        "index.html: the velocity-warning note for ethereum has no marker in view and footnote with its words",
      );
    });

    it("a warning on another chain moves the note it asks for", () => {
      const moved = [notes[0], { ...notes[1], chain: "base" }];
      const body = plantedNotes(notes) + plantedNotesFlight(moved);
      const problems = verifyOutput(mainWith(body), {
        ...sampleExpected,
        essentialNotes: moved,
      });
      expect(problems).toEqual([
        "index.html: the velocity-warning note for base has no marker in view and footnote with its words",
      ]);
    });

    it("fails on a note that keeps its kind and loses its words", () => {
      const body =
        plantedNotes([notes[0], { ...notes[1], text: "Fine." }]) + plantedNotesFlight(notes);
      expect(verifyOutput(mainWith(body), expected)).toEqual([
        'index.html: the velocity-warning note for ethereum doesn\'t say "A dated warning."',
      ]);
    });

    it("reads a note whole, across its date and its link", () => {
      const text = "Flows count from 3 Nov 2026 UTC, here.";
      const split = plantedNotes([
        {
          kind: "day-0-scope",
          text: "\n        Flows count from <!-- -->3 Nov 2026 UTC<!-- -->, <em>here</em>.",
          tip: '<a href="/methodology/#x">How</a>',
        },
      ]).replace(/<script>.*?<\/script>/, "");
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
        expect(verifyOutput(mainWith(body), twice)).toContain(
          'index.html: the wallets-not-people note doesn\'t say "Wallets."',
        );
      });
    });
  });

  describe("the figures the dataset fixes", () => {
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
        `${STALE_TRUST}${PLANTED_TRUST_LINK}`,
        `<details class="data-toggle"><summary>${STALE_TRUST}</summary></details>${PLANTED_TRUST_LINK}`,
      ),
    );
    const dir = site({ main: html, methodology: realPage("<main>M</main>") });
    expect(verifyOutput(dir, realExpected)).toEqual([]);
  });

  it("fails when a passing build keeps the trust row or the stale note at the top", () => {
    const back = FRESH_MAIN.replace(
      "<main>",
      `<main><section data-section="trust-strip">${FRESH_TRUST}${PLANTED_TRUST_LINK}</section>`,
    );
    const dir = site({ main: freshPage(back), methodology: freshPage("<main>M</main>") });
    expect(verifyOutput(dir, freshRealExpected)).toContain(
      "index.html: real data that's only old has the trust row at the top",
    );
    const noted = site({
      main: freshPage(FRESH_MAIN).replace(
        "</header>",
        `</header><p data-stale-note>${STALE_NOTE}</p>`,
      ),
      methodology: freshPage("<main>M</main>"),
    });
    expect(verifyOutput(noted, freshRealExpected)).toContain(
      "index.html: a stale note is at the top of real data",
    );
  });

  it("fails when a passing build's as-of line loses when the data is from, or says it's old", () => {
    const check = (main: string) =>
      verifyOutput(
        site({ main: freshPage(main), methodology: freshPage("<main>M</main>") }),
        freshRealExpected,
      );
    expect(check(FRESH_MAIN.replace(`<p>${HEAD_STALE}</p>`, "<p>Data.</p>"))).toContain(
      "index.html: the verdict block has no stale text",
    );
    expect(
      check(
        FRESH_MAIN.replace(`<p>${HEAD_STALE}</p>`, `<p>${HEAD_STALE} Last reconciled 4 Nov.</p>`),
      ),
    ).toContain("index.html: the line under the headline says more than when the data is from");
    expect(
      check(
        FRESH_MAIN.replace(`<p>${HEAD_STALE}</p>`, `<p>${HEAD_STALE} It may be out of date.</p>`),
      ),
    ).toContain("index.html: the line under the headline says more than when the data is from");
  });

  it("fails when a fresh page drops its fresh as-of text", () => {
    const dir = site({
      main: freshPage(FRESH_MAIN.replace("<p>Data as of 3 Nov 2026 UTC.</p>", "")),
      methodology: freshPage("<main>M</main>"),
    });
    expect(verifyOutput(dir, freshRealExpected)).toContain(
      "index.html: the verdict block has no fresh text",
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
    const expected = expectedFromDataset(at(markStale(releaseGrade())));
    expect(expected.freshness).toBe("stale");
    expect(expected.asOfLine.stale).toContain("A newer run did not pass its checks.");
    expect(expected.trustLine.fresh).toBeNull();
  });
});

describe("the footer's reconciliation status", () => {
  const RECONCILED = plantedFooter(true, freshRealExpected.trustLine, REPORTS);
  const preview = { ...sampleExpected, kind: "preview", frameWord: "Preview" };
  const previewPage = (body: string, footer = SAMPLE_FOOTER) =>
    page(
      body,
      'data-dataset-kind="preview" data-dataset-version="20261104T060000Z" data-frame="Preview" data-freshness="stale"',
      "[Preview] Open USD Monitor",
      '<meta name="robots" content="noindex, nofollow"/>',
      footer,
    )
      .replace("Sample data. Nothing here is real.", "Local preview. Not the published site.")
      .replaceAll("Sample", "Preview");
  const PROBLEM = 'the footer says "Reconciled" on a build that didn\'t pass';

  it("passes Reconciled, with its tooltip, on a build that passed", () => {
    expect(FRESH_FOOTER).toContain("data-reconciled");
    const dir = site({ main: freshPage(FRESH_MAIN), methodology: freshPage("<main>M</main>") });
    expect(verifyOutput(dir, freshRealExpected)).toEqual([]);
  });

  it.each([
    [
      "sample",
      () => site({ main: page(MAIN, undefined, undefined, undefined, RECONCILED) }),
      sampleExpected,
    ],
    [
      "preview",
      () =>
        site({
          main: previewPage(MAIN, RECONCILED),
          methodology: previewPage("<main>Methodology</main>"),
        }),
      preview,
    ],
    [
      "stale",
      () =>
        site({
          main: realPage(REAL_MAIN, RECONCILED),
          methodology: realPage("<main>Methodology</main>"),
        }),
      realExpected,
    ],
  ])("fails on Reconciled in the footer of a %s build", (_name, dir, expected) => {
    const problems = verifyOutput(dir(), expected);
    expect(problems).toContain(`index.html: ${PROBLEM}`);
    // Each page has the footer, so each is checked.
    expect(problems).not.toContain(`methodology/index.html: ${PROBLEM}`);
  });

  it("fails on the word alone, swapped out or unmarked, on a build that didn't pass", () => {
    const unmarked = SAMPLE_FOOTER.replace(
      '<span aria-hidden="true">○</span>',
      '<span aria-hidden="true">○</span> Reconciled ',
    );
    expect(unmarked).not.toBe(SAMPLE_FOOTER);
    expect(
      verifyOutput(
        site({ main: page(MAIN, undefined, undefined, undefined, unmarked) }),
        sampleExpected,
      ),
    ).toContain(`index.html: ${PROBLEM}`);
    // On old real data, swapped in where the clock state is.
    const swappedOut = REAL_FOOTER.replace(
      '<span class="freshness-text__stale">',
      '<span class="freshness-text__stale"><span data-reconciled>Reconciled</span> ',
    );
    expect(swappedOut).not.toBe(REAL_FOOTER);
    expect(
      verifyOutput(
        site({
          main: realPage(REAL_MAIN, swappedOut),
          methodology: realPage("<main>M</main>", swappedOut),
        }),
        realExpected,
      ),
    ).toContain(`index.html: ${PROBLEM}`);
  });

  it("fails when a passing build's Reconciled loses its tooltip, its tick or its link", () => {
    const check = (footer: string) =>
      verifyOutput(
        site({
          main: realPage(FRESH_MAIN, footer).replace(
            'data-freshness="stale"',
            'data-freshness="fresh"',
          ),
          methodology: freshPage("<main>M</main>"),
        }),
        freshRealExpected,
      );
    expect(check(FRESH_FOOTER.replace(FRESH_TRUST, "Fine."))).toContain(
      'index.html: the footer\'s "Reconciled" has no tooltip with the dated sentence',
    );
    expect(
      check(
        FRESH_FOOTER.replace(
          '<svg aria-hidden="true"><path d="M0 0"></path></svg>Reconciled',
          "Reconciled",
        ),
      ),
    ).toContain('index.html: the footer\'s "Reconciled" lost its tick or its word');
    expect(check(FRESH_FOOTER.replaceAll('href="/reconciliation/"', 'href="/"'))).toEqual(
      expect.arrayContaining([
        "index.html: the footer's status doesn't link to the reconciliation page",
      ]),
    );
    expect(
      check(
        FRESH_FOOTER.replace(
          /<span class="freshness-text__stale">.*?<\/span><\/span><\/p>/,
          "</span></p>",
        ),
      ),
    ).toContain("index.html: the footer has no clock state to show once the data is old");
  });

  it("passes the clock state on old real data, and fails when it isn't a clock, its day or its tooltip", () => {
    const check = (footer: string) =>
      verifyOutput(
        site({
          main: realPage(REAL_MAIN, footer),
          methodology: realPage("<main>M</main>", footer),
        }),
        realExpected,
      );
    expect(check(REAL_FOOTER)).toEqual([]);
    const CLOCK = '<circle r="1"></circle>';
    expect(REAL_FOOTER).toContain(CLOCK);
    expect(check(REAL_FOOTER.replace(CLOCK, ""))).toContain(
      `index.html: the footer's clock state isn't a clock and "${SHORT_TRUST}"`,
    );
    expect(check(REAL_FOOTER.replace(`>${SHORT_TRUST}</a>`, ">Reconciled</a>"))).toContain(
      `index.html: the footer's clock state isn't a clock and "${SHORT_TRUST}"`,
    );
    expect(check(REAL_FOOTER.replace(`>${STALE_TRUST}</span>`, ">Old.</span>"))).toContain(
      "index.html: the footer's clock state has no tooltip with the dated sentence",
    );
    expect(
      check(REAL_FOOTER.replace("data-stale-status>", 'data-stale-status style="display:none">')),
    ).toContain("index.html: the footer's clock state isn't in view on old data");
  });

  it("fails with no status in the footer, and with the wrong state's words", () => {
    const none = page(
      MAIN,
      undefined,
      undefined,
      undefined,
      `<footer><p>${LINE}</p><nav><a href="/methodology">M</a></nav><p>Not financial advice.</p></footer>`,
    );
    expect(verifyOutput(site({ main: none }), sampleExpected)).toContain(
      "index.html: no reconciliation status in the footer",
    );
    const wrong = SAMPLE_FOOTER.replaceAll("Not reconciled", "Checked");
    expect(
      verifyOutput(
        site({ main: page(MAIN, undefined, undefined, undefined, wrong) }),
        sampleExpected,
      ),
    ).toContain("index.html: the footer's status doesn't say \"Not reconciled\"");
  });
});

describe("the reconciliation page", () => {
  const check = (main: string) =>
    verifyOutput(site({ reconciliation: page(main) }), sampleExpected);
  const DETAIL = plantedReconciliationMain(SAMPLE_RUN);

  it("passes the detail with its state, caveat, link, table and a way back", () => {
    expect(check(DETAIL)).toEqual([]);
  });

  it.each([
    [
      "the detail gone",
      (html: string) => html.replace('data-section="reconciliation"', ""),
      "there are 0 reconciliation details, not one",
    ],
    [
      "the caveat lost",
      (html: string) => html.replace(PLANTED_TRUST_CAVEAT, ""),
      "the detail has lost what it says it doesn't verify",
    ],
    [
      "the caveat only in a tooltip",
      (html: string) =>
        html.replace(PLANTED_TRUST_CAVEAT, plantedTip("More", PLANTED_TRUST_CAVEAT)),
      "the detail has lost what it says it doesn't verify",
    ],
    [
      "the state lost",
      (html: string) => html.replace(`<p data-run-line>${SAMPLE_RUN}</p>`, ""),
      "the detail doesn't state the reconciliation's state",
    ],
    [
      "a check lost from the list",
      (html: string) => html.replace(/<div class="check-list__row">.*?<\/div>/, ""),
      "the detail doesn't list every check with its result",
    ],
    [
      "the definition link lost",
      (html: string) => html.replace('<a href="/methodology/#reconciliation">How it works</a>', ""),
      "the detail has no definition link",
    ],
    [
      "the table lost, with no unknown text",
      (html: string) => html.replace(/<table>.*?<\/table>/, ""),
      'the detail has neither its table nor "Not enough data yet"',
    ],
    [
      "the way back lost",
      (html: string) => html.replace(PLANTED_BACK, ""),
      'no "Back to the dashboard" link to /',
    ],
    [
      "the way back pointing elsewhere",
      (html: string) => html.replace('<a href="/" aria-label', '<a href="/methodology" aria-label'),
      'no "Back to the dashboard" link to /',
    ],
    [
      "the way back under the title",
      (html: string) => html.replace(PLANTED_BACK, "").replace("</h1>", `</h1>${PLANTED_BACK}`),
      "the way back isn't above the page's title",
    ],
  ])("fails with %s", (_name, change, problem) => {
    const changed = change(DETAIL);
    expect(changed).not.toBe(DETAIL);
    expect(check(changed)).toContain(`reconciliation/index.html: ${problem}`);
  });
});

describe("tooltips", () => {
  const TEXT =
    '<span class="tip" data-tip><button type="button" class="tip__trigger" aria-describedby="t1">Short</button><span class="tip__panel" id="t1" role="tooltip">In full.</span></span>';
  const LINKED =
    '<span class="tip" data-tip><button type="button" class="tip__trigger" aria-expanded="false" aria-controls="t2">More</button><span class="tip__panel" id="t2"><a href="/methodology/#velocity">Definition</a></span></span>';
  const check = (html: string) => verifyOutput(mainWith(`<p>${html}</p>`), sampleExpected);
  const KEYBOARD = "index.html: a tooltip's trigger can't be reached by keyboard, or has no name";

  it("passes a plain tooltip and a disclosure with a link, as the components write them", () => {
    expect(plantedTip("Short", "In full.")).toContain('role="tooltip"');
    expect(plantedTip("More", '<a href="/">x</a>')).toContain('aria-expanded="false"');
    expect(check(`${TEXT}${LINKED}`)).toEqual([]);
  });

  it.each([
    ["a div for its trigger", TEXT.replace("<button", "<div").replace("</button>", "</div>")],
    ["a trigger out of the tab order", TEXT.replace("<button", '<button tabindex="-1"')],
    ["a link with no destination", TEXT.replace("<button", "<a").replace("</button>", "</a>")],
    ["a trigger with no name", TEXT.replace(">Short</button>", "></button>")],
  ])("fails on %s", (_name, html) => {
    expect(check(html)).toContain(KEYBOARD);
  });

  it("fails on a panel that doesn't follow its trigger, so Tab can't move into it", () => {
    const apart = TEXT.replace(
      '</button><span class="tip__panel"',
      '</button><span>between</span><span class="tip__panel"',
    );
    expect(check(apart)).toContain("index.html: a tooltip's panel doesn't follow its trigger");
  });

  it("fails on a link in a role=tooltip panel, which can't be reached", () => {
    const linked = TEXT.replace("In full.", '<a href="/methodology/#velocity">Definition</a>');
    expect(check(linked)).toContain("index.html: a tooltip with a link isn't a disclosure");
    const noExpanded = LINKED.replace(' aria-expanded="false"', "");
    expect(check(noExpanded)).toContain("index.html: a tooltip with a link isn't a disclosure");
  });

  it("fails on a trigger that doesn't point at its panel, or a description with no role", () => {
    expect(check(TEXT.replace('aria-describedby="t1"', ""))).toContain(
      "index.html: a tooltip's trigger doesn't point at its panel",
    );
    expect(check(TEXT.replace(' role="tooltip"', ""))).toContain(
      'index.html: a tooltip describing its trigger has no role="tooltip"',
    );
  });

  it("checks every page's tooltips, the footer's included", () => {
    const methodology = page(`<main>${TEXT.replace("<button", '<button tabindex="-1"')}</main>`);
    expect(verifyOutput(site({ methodology }), sampleExpected)).toContain(
      `methodology/index.html: ${KEYBOARD.replace("index.html: ", "")}`,
    );
  });
});

describe("push-down explanations", () => {
  const inMain = (html: string) => site({ main: page(MAIN.replace("</main>", `${html}</main>`)) });

  it("allows a data toggle, and fails on any other details in main", () => {
    expect(
      verifyOutput(
        inMain('<details class="data-toggle"><summary>Table</summary></details>'),
        sampleExpected,
      ),
    ).toEqual([]);
    for (const details of [
      '<details class="info-popover" name="info"><summary aria-label="About"></summary><p>x</p></details>',
      '<details class="accordion"><summary>How we read this</summary><p>x</p></details>',
      "<details><summary>Legend</summary><p>x</p></details>",
    ]) {
      expect(verifyOutput(inMain(details), sampleExpected)).toContain(
        "index.html: an explanation pushes the page down, in a details element",
      );
    }
    // Outside main, the methodology page's contents may still fold on a phone.
    expect(
      verifyOutput(mainWith("<details><summary>x</summary></details>"), sampleExpected),
    ).toEqual([]);
  });
});

describe("the Preview frame", () => {
  const preview = { ...sampleExpected, kind: "preview", frameWord: "Preview" };

  it("wants the Preview word, not the Sample one", () => {
    const problems = verifyOutput(site(), preview);
    expect(problems).toContain("index.html: page root says sample, dataset is preview");
    expect(problems).toContain("index.html: no [Preview] in the title");
    expect(problems).toContain(
      'index.html: the verdict doesn\'t say "Preview, not a finding." in view',
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
