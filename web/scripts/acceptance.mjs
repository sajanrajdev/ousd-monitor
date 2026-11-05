// Local only, and never run by `make check`. Reaches the built site in a real browser, with what a
// unit test can't see: layout, focus, hover, touch and the native behaviour with JavaScript off.
// Each unit adds its checks. Usage: acceptance.mjs [--widths=390,1440] [built folder ...], by default
// both samples at every width. Checks that need real data say "Not run" when no folder holds any.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { launch, serve } from "./local-browser.mjs";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const ALL_WIDTHS = [320, 390, 768, 1056, 1440];
const AXE_WIDTHS = new Set([390, 1440]);
const HEIGHT = 900;
const BREAKPOINT_MD = 768;
const TWO_COLUMNS_FROM = 1056;
const NOTES_BESIDE_FROM = 560;
// Each card's anchor, as lib/definitions.ts has them.
const CARDS = {
  supply: "where-supply-sits",
  series: "placed-vs-circulating",
  waterfall: "headline-to-clean",
  weekly: "everyday-by-week",
  velocity: "velocity-by-chain",
  chainRoles: "what-each-chain-does",
};
const MIN_TARGET = 24;
const MIN_FILTER_TARGET = 36;
const LEGEND_TRIGGER_GAP = 12;
const CLOCK_JUMP_MS = 72 * 60 * 60 * 1000;
// The plan's fold, on real data: a sample or preview adds its banner, and may run longer.
const FOLDS = [
  {
    viewport: { width: 1440, height: 900 },
    above: ["trust-strip", "verdict", "kpi-row", "findings", "marker-legend"],
  },
  {
    viewport: { width: 390, height: 844 },
    above: ["trust-strip", "verdict", "kpi-row"],
    starts: "findings",
  },
];
// Longer than the enhancer's hover delays, so a panel has had the chance to change.
const HOVER_SETTLE_MS = 500;
const STEP_TIMEOUT_MS = 5000;
const BOX_SLACK_PX = 0.5;
// The frame's hatched edges are pseudo-elements, which leave axe unable to judge the text near them.
const WITHOUT_FRAME_EDGES = `html[data-frame] body::before, html[data-frame] body::after,
  .chart-card[data-frame]::before, .finding[data-frame]::before { content: none !important; }`;

const counts = new Map();
const undeterminedContrast = [];
const failures = [];
const notRun = new Set();

function check(name, where, ok, detail = "") {
  const count = counts.get(name) ?? { pass: 0, fail: 0 };
  count[ok ? "pass" : "fail"] += 1;
  counts.set(name, count);
  if (!ok) failures.push(`${where}: ${name}${detail ? ` (${detail})` : ""}`);
}

// A step that can't finish is a failure of that step, and the other checks still run and report.
async function guarded(name, where, run) {
  try {
    await run();
  } catch (error) {
    check(`${name} ran to the end`, where, false, error.message.split("\n")[0]);
  }
}

// Plain cards side by side, with a table too wide for half a card and nothing but what every card
// has, as the views' own cards differ until every unit is in. So this renders the real component with
// made-up amounts, and puts it in the built page, where the real CSS and enhancer apply. U3 dropped the
// filter and panels from here, as the page now has its own. Drop the rest when nothing needs it.
async function loadHarness() {
  const vite = await createServer({
    root: WEB_DIR,
    configFile: false,
    appType: "custom",
    logLevel: "error",
    resolve: { alias: { "@": WEB_DIR.replace(/\/$/, "") } },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  const load = (path) => vite.ssrLoadModule(path);
  const [{ ChartCard }, { Pin }, verdict] = await Promise.all([
    load("/components/chart-card.tsx"),
    load("/components/pinned-notes.tsx"),
    load("/lib/verdict.ts"),
  ]);
  const card = (name, props) => {
    const notes = [{ kind: "harness", text: `On ${name}, a made-up caveat.` }];
    return h(
      ChartCard,
      {
        takeaway: `A made-up finding about ${name}`,
        chip: "inferred",
        source: "Made-up data",
        asOf: "2026-11-03",
        definitionHref: "/methodology/#velocity",
        frameWord: "Sample",
        summary: `A made-up summary of ${name}.`,
        notes,
        table: {
          caption: `Made-up amounts for ${name}`,
          columns: ["Chain", "One", "Two", "Three", "Four", "Five", "Six", "Seven"].map(
            (label) => ({
              key: label,
              label,
              numeric: label !== "Chain",
            }),
          ),
          rows: [
            {
              Chain: name,
              One: "12345678901234567890",
              Two: "12345678901234567890",
              Three: "12345678901234567890",
              Four: "12345678901234567890",
              Five: "12345678901234567890",
              Six: "12345678901234567890",
              Seven: "12345678901234567890",
            },
          ],
        },
        ...props,
      },
      h(Pin, { notes, kind: "harness" }),
    );
  };
  const markup = renderToStaticMarkup(
    h(
      "section",
      { "data-harness": "" },
      h(
        "div",
        { className: "card-grid" },
        card("no filter", { id: "harness-plain" }),
        card("its neighbour", { id: "harness-neighbour" }),
      ),
    ),
    { identifierPrefix: "harness-" },
  );
  return {
    markup,
    oneLineHeadline: verdict.VERDICT_SENTENCES.mostly_placed,
    close: () => vite.close(),
  };
}

// The enhancer has mounted once Escape closes an open popover. Nothing on the page says so otherwise.
async function enhancerReady(page) {
  await page.waitForFunction(() => {
    const popover = document.querySelector(".info-popover");
    if (!popover) return true;
    popover.open = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const closed = !popover.open;
    popover.open = false;
    return closed;
  });
  await page.evaluate(() => document.activeElement?.blur());
}

// Swaps the two @supports conditions in the built CSS, so Chromium applies what a browser without
// :has() would. Rules using :has() outside those blocks don't change what the filter or toggle do.
async function behaveWithoutHas(page) {
  await page.route("**/*.css", async (route) => {
    const response = await route.fetch();
    const css = (await response.text())
      .replaceAll("not selector(:has(*))", "SUPPORTED")
      .replaceAll("selector(:has(*))", "not selector(html)")
      .replaceAll("SUPPORTED", "selector(html)");
    await route.fulfill({ response, body: css });
  });
}

async function openPage(
  browser,
  origin,
  folder,
  markup,
  { width, js, touch = false, forcedColors = "none", withoutHas = false },
) {
  const context = await browser.newContext({
    viewport: { width, height: HEIGHT },
    javaScriptEnabled: js,
    hasTouch: touch,
    forcedColors,
  });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  const page = await context.newPage();
  if (withoutHas) await behaveWithoutHas(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // With scripts off nothing can add it afterwards, and nothing will hydrate over it.
  if (!js) {
    const html = readFileSync(join(folder, "index.html"), "utf8");
    await page.route(`${origin}/`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: html.replace("</main>", `${markup}</main>`),
      }),
    );
  }
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  if (js) {
    await enhancerReady(page);
    await page.evaluate((html) => {
      document.querySelector("main").insertAdjacentHTML("beforeend", html);
    }, markup);
  }
  return { context, page, errors };
}

const shownPanels = (page) =>
  page.$$eval("[data-chain-panel]", (panels) =>
    panels
      .filter((panel) => panel.getClientRects().length > 0)
      .map((panel) => panel.dataset.chainPanel),
  );

// The cards a filter option changes, so each check covers every one of them.
const FILTERED_CARDS = [
  "#where-supply-sits",
  "#placed-vs-circulating",
  "#headline-to-clean",
  "#everyday-by-week",
];
const SUPPLY = "#where-supply-sits";
const SERIES = "#placed-vs-circulating";
const shownCard = (page, box) =>
  page.locator(`${box} > [data-chain-panel] > .chart-card:visible`).first();

const openCount = (page) => page.locator(".info-popover[open]").count();
const isOpen = (locator) => locator.evaluate((details) => details.open);
const focusIsOn = (locator) => locator.evaluate((element) => document.activeElement === element);

const chosenOptionDiffers = (page) =>
  page.evaluate(() => {
    const look = (selector) => {
      const { backgroundColor, color } = getComputedStyle(document.querySelector(selector));
      return `${backgroundColor} ${color}`;
    };
    return (
      look(".chain-filter input:checked + span") !==
      look(".chain-filter input:not(:checked) + span")
    );
  });

async function checkFilter(page, where, js, chains) {
  const radios = page.locator(".chain-filter input");
  const values = await radios.evaluateAll((inputs) => inputs.map((input) => input.value));
  const firstLabel = chains.length === 4 ? "All" : "All covered";
  check(
    "the first option reads All or All covered",
    where,
    (await page.locator(".chain-filter label").first().innerText()).trim() === firstLabel,
  );
  check(
    "the filter lists only chains in the data",
    where,
    values.join() === ["all", ...chains].join(),
    values.join(),
  );
  check("the chosen option looks different", where, await chosenOptionDiffers(page));
  for (const [index, value] of values.entries()) {
    await page.locator(".chain-filter label").nth(index).click();
    const shown = await shownPanels(page);
    check(
      "choosing a filter shows one panel in each filtered card",
      where,
      shown.length === FILTERED_CARDS.length && shown.every((panel) => panel === value),
      `${value}: ${shown}`,
    );
    // The first option is already chosen, so clicking it changes nothing to announce.
    if (js && index > 0) {
      const status = await page.locator("[data-chain-status]").textContent();
      check("the status line says what's showing", where, status.startsWith("Showing "));
    }
  }
  await page.locator(".chain-filter label").first().click();
  await page.keyboard.press("ArrowRight");
  const moved = await shownPanels(page);
  check(
    "the right arrow moves to the next option",
    where,
    moved.length === FILTERED_CARDS.length && moved.every((panel) => panel === values[1]),
  );
  await page.keyboard.press("ArrowLeft");
  const back = await shownPanels(page);
  check(
    "the left arrow moves back",
    where,
    back.length === FILTERED_CARDS.length && back.every((panel) => panel === values[0]),
  );
}

// What must be in view with nothing opened. A stylesheet can hide what verify-output can't read.
async function checkInView(page, where) {
  const missing = await page.evaluate(() => {
    const startX = window.scrollX;
    const startY = window.scrollY;
    // Whether the element is what's at a point, once scrolled to. A clip, a cover or an off-screen
    // box leaves something else there, or nothing.
    const hits = (element, rectOf) => {
      const before = rectOf();
      window.scrollBy({
        left: before.left + before.width / 2 - window.innerWidth / 2,
        top: before.top + before.height / 2 - window.innerHeight / 2,
        behavior: "instant",
      });
      const box = rectOf();
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return element.contains(at);
    };
    // The first and last lines of its text, so clipping part of a note counts as well.
    const textLines = (element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const ranges = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!node.data.trim() || parent.closest(".sr-only") || !parent.checkVisibility()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (range.getClientRects().length > 0) ranges.push(range);
      }
      if (ranges.length === 0) return [];
      return [
        () => ranges[0].getClientRects()[0],
        () => [...ranges.at(-1).getClientRects()].at(-1),
      ];
    };
    const seen = (element) => {
      if (!element?.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
      const box = element.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) return false;
      const { scrollWidth, scrollHeight } = document.documentElement;
      const onPage =
        box.right + window.scrollX > 0 &&
        box.left + window.scrollX < scrollWidth &&
        box.bottom + window.scrollY > 0 &&
        box.top + window.scrollY < scrollHeight;
      if (!onPage) return false;
      // The first fragment's centre: a wrapped inline box's own centre can fall outside its text.
      const spots = [() => element.getClientRects()[0], ...textLines(element)];
      return spots.every((rectOf) => hits(element, rectOf));
    };
    const lacking = [];
    const need = (name, element) => {
      if (!seen(element)) lacking.push(name);
    };
    const root = document.documentElement;
    need("the header's independence line", document.querySelector("header .independence-line"));
    need("the footer's independence line", document.querySelector("footer .independence-line"));
    if (root.dataset.frame) need("the banner", document.querySelector("[data-dataset-banner]"));
    const verdict = document.querySelector('[data-section="verdict"]');
    if (verdict) {
      need("the question line", verdict.querySelector('[data-section="question"]'));
      need("the headline", verdict.querySelector("h1"));
      const text = verdict.querySelector("[data-verdict-text]");
      if (text?.closest("details")) {
        if (root.dataset.datasetKind !== "real") lacking.push("verdict.text, on non-real data");
      } else {
        need("verdict.text", text);
      }
      need("the headline's marker", verdict.querySelector('.status-chip[data-kind="opinion"]'));
      const when = [...verdict.querySelectorAll(".freshness-text > *")];
      if (!when.some(seen)) lacking.push("the as-of line");
      const trust = document.querySelectorAll('[data-section="trust-strip"] .freshness-text > *');
      if (![...trust].some(seen)) lacking.push("the trust status");
      for (const value of document.querySelectorAll("[data-kpi-value]")) need("a KPI value", value);
      for (const chip of document.querySelectorAll('[data-section="kpi-row"] .status-chip')) {
        need("a KPI marker", chip.querySelector("[aria-hidden]") ?? chip);
      }
      for (const label of document.querySelectorAll('[data-section="kpi-row"] dt')) {
        need("a KPI label", label);
      }
      need("the KPI row's chains", document.querySelector('[data-section="kpi-row"] > p'));
      const findings = document.querySelectorAll("[data-finding-link]");
      if (findings.length === 0) lacking.push("the findings");
      for (const finding of findings) {
        need("a finding", finding.querySelector(".finding__text"));
        const chip = finding.querySelector(".status-chip");
        need("a finding's marker", chip?.querySelector("[aria-hidden]") ?? chip);
        if (root.dataset.frame) {
          need("a finding's word", finding.querySelector(".chart-card__frame-word"));
        }
      }
      need("the legend", document.querySelector('[data-section="marker-legend"] > p'));
    }
    // Every caveat, wherever a unit pins it. A note in a filter panel counts while its panel shows.
    for (const caveat of document.querySelectorAll("main [data-note]")) {
      const panel = caveat.closest("[data-chain-panel]");
      if (!panel || panel.checkVisibility()) need(`the ${caveat.dataset.note} note`, caveat);
    }
    // An exchange's name and its source. A closed disclosure may hold them, and no stylesheet may hide them.
    for (const row of document.querySelectorAll("main [data-exchange-row]")) {
      const panel = row.closest("[data-chain-panel]");
      if (row.closest("details:not([open])") || (panel && !panel.checkVisibility())) continue;
      need("an exchange row", row);
      need("an exchange row's name", row.querySelector("[data-exchange-name]"));
      need("an exchange row's detail", row.querySelector("[data-exchange-detail]"));
      need("an exchange row's source", row.querySelector("[data-exchange-source]"));
    }
    // A legend's rows and the figures beside a bar, wherever their panel shows.
    for (const row of document.querySelectorAll(
      "main .chart-legend__row, main [data-stat], main [data-exchange-linked]",
    )) {
      const panel = row.closest("[data-chain-panel]");
      if (!panel || panel.checkVisibility()) need("a legend row or a figure beside its bar", row);
    }
    const note = document.querySelector("[data-stale-note] .freshness-text > *");
    if (!verdict && root.dataset.freshness === "stale") need("the stale note", note);
    for (const card of document.querySelectorAll(".chart-card")) {
      if (!card.checkVisibility()) continue;
      need("a card's heading", card.querySelector(".chart-card__head :is(h2, h3)"));
      const chip = card.querySelector(".chart-card__head .status-chip");
      need("a card's marker", chip?.querySelector("[aria-hidden]") ?? chip);
      need("a card's meta line", card.querySelector(".chart-card__meta"));
      need("a card's as-of time", card.querySelector(".chart-card__meta time"));
      if (root.dataset.frame) {
        need("a card's frame word", card.querySelector(".chart-card__frame-word"));
      }
      for (const item of card.querySelectorAll("[data-pinned-notes] > li")) {
        need("a pinned note", item);
        need("a note's number", item.querySelector(".pin"));
      }
    }
    window.scrollTo({ left: startX, top: startY, behavior: "instant" });
    return lacking;
  });
  check(
    "everything essential is in view",
    where,
    missing.length === 0,
    [...new Set(missing)].join(", "),
  );
}

// On a fresh page, before any click, as a mouse changes what counts as :focus-visible.
async function checkFocusRings(page, where) {
  await page.keyboard.press("Shift");
  for (const selector of [
    ".info-popover > summary",
    ".data-toggle > summary",
    ".chain-filter input:checked",
    "header a",
    ".trust-strip summary",
    "[data-finding-link]",
  ]) {
    const target = page.locator(selector).first();
    await target.focus();
    const shows = await target.evaluate((element) => {
      const ringed = element.matches(".chain-filter input") ? element.nextElementSibling : element;
      const { outlineStyle, outlineWidth } = getComputedStyle(ringed);
      return outlineStyle !== "none" && parseFloat(outlineWidth) > 0;
    });
    check("focus shows an outline", where, shows, selector);
  }
  await page.evaluate(() => document.activeElement?.blur());
}

async function checkMethodologyPage(browser, origin, where, js) {
  const context = await browser.newContext({ javaScriptEnabled: js });
  const page = await context.newPage();
  await page.goto(`${origin}/methodology/`, { waitUntil: "networkidle" });
  await checkInView(page, `${where} methodology`);
  await context.close();
}

// Forced colours drop backgrounds, so the chosen option and open trigger need their own rule.
async function checkForcedColors(browser, origin, folder, markup, where, options) {
  const { context, page } = await openPage(browser, origin, folder, markup, {
    ...options,
    forcedColors: "active",
  });
  check("the chosen option shows in forced colours", where, await chosenOptionDiffers(page));
  const trigger = page.locator("#harness-plain .info-popover > summary");
  const before = await trigger.evaluate((element) => getComputedStyle(element).backgroundColor);
  await trigger.click();
  const after = await trigger.evaluate((element) => getComputedStyle(element).backgroundColor);
  check("an open trigger shows in forced colours", where, before !== after);
  await context.close();
}

// Long but complete: no filter that can do nothing, every panel, and a toggle that doesn't say Chart.
async function checkWithoutHas(browser, origin, folder, markup, chains, where, options) {
  const { context, page } = await openPage(browser, origin, folder, markup, {
    ...options,
    withoutHas: true,
  });
  await context.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...query) => (String(query[0]).includes(":has(") ? false : supports(...query));
  });
  check(
    "without :has(), the filter is hidden",
    where,
    !(await page.locator(".chain-filter").isVisible()),
  );
  const shown = await shownPanels(page);
  check(
    "without :has(), every panel shows",
    where,
    shown.length === (chains.length + 1) * FILTERED_CARDS.length,
    `${shown}`,
  );
  // The stylesheet can be made to act without :has(), but what scripts ask has to be told as well.
  if (options.js) {
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector("#placed-vs-circulating svg"));
    const drawn = await page.locator(`${SERIES} .recharts-wrapper`).count();
    check("without :has(), every step line draws", where, drawn === chains.length + 1, `${drawn}`);
    await page.evaluate((html) => {
      document.querySelector("main").insertAdjacentHTML("beforeend", html);
    }, markup);
  }
  const card = page.locator("#harness-plain");
  const summary = card.locator(".data-toggle > summary");
  await summary.click();
  check(
    "without :has(), the toggle doesn't say Chart",
    where,
    (await summary.innerText()).trim().startsWith("Table"),
  );
  check(
    "without :has(), the plot stays",
    where,
    await card.locator(".chart-card__plot").isVisible(),
  );
  check("without :has(), the table shows", where, await card.locator("table").isVisible());
  await context.close();
}

async function checkOneAtATime(page, where) {
  const triggers = page.locator("[data-harness] .info-popover > summary:visible");
  await triggers.nth(0).click();
  await triggers.nth(1).click();
  check("one popover opens at a time", where, (await openCount(page)) === 1);
  await triggers.nth(1).click();
  await triggers.nth(0).focus();
  await page.keyboard.press("Enter");
  check("Enter opens a popover", where, (await openCount(page)) === 1);
  await page.keyboard.press("Space");
  check("Space closes a popover", where, (await openCount(page)) === 0);
}

// Everything a reader needs to read must keep its own box while any popover is open.
async function checkNothingCovered(page, where) {
  const results = await page.evaluate(() => {
    const WATCHED =
      ".chart-area, .hairline-table, .pinned-notes > li, .chart-card__meta, .chart-card h2, .chart-card h3, .status-chip, .data-toggle > summary, h1, [data-section='question'], .freshness-text, [data-verdict-text], [data-kpi-value], [data-section='kpi-row'] dt, [data-section='kpi-row'] > p, [data-finding-link], [data-section='marker-legend'] > p";
    const out = [];
    for (const popover of document.querySelectorAll(".info-popover")) {
      // A hidden filter panel's popover has no box to check.
      if (!popover.closest(".explain-head").checkVisibility()) continue;
      popover.open = true;
      const panel = popover.querySelector(".info-popover__panel");
      const box = panel.getBoundingClientRect();
      const covered = [...document.querySelectorAll(WATCHED)].filter((element) => {
        // checkVisibility, as what's in a closed details keeps a box but isn't drawn.
        if (panel.contains(element) || !element.checkVisibility()) return false;
        const other = element.getBoundingClientRect();
        return (
          other.left < box.right - 0.5 &&
          other.right > box.left + 0.5 &&
          other.top < box.bottom - 0.5 &&
          other.bottom > box.top + 0.5
        );
      });
      const small = [...panel.querySelectorAll("a")].filter(
        (link) => link.getBoundingClientRect().height < 24,
      );
      out.push({ covered: covered.map((element) => element.className), small: small.length });
      popover.open = false;
    }
    return out;
  });
  check("the page has popovers to check", where, results.length > 0);
  for (const { covered, small } of results) {
    check(
      "an open popover covers no plot, value or note",
      where,
      covered.length === 0,
      `${covered}`,
    );
    check("a link in a popover is at least 24 px", where, small === 0);
  }
}

async function checkHover(page, where) {
  const popover = page.locator("#harness-plain .info-popover");
  const trigger = popover.locator("summary");
  const panel = popover.locator(".info-popover__panel");
  const away = () => page.mouse.move(0, 0);
  const settle = () => page.waitForTimeout(HOVER_SETTLE_MS);

  await page.evaluate(() => document.activeElement?.blur());
  await away();
  await settle();
  check("no popover is open before a hover", where, (await openCount(page)) === 0);
  await trigger.hover();
  await settle();
  check("hover opens", where, await isOpen(popover), `${await openCount(page)} open`);
  await panel.hover();
  await settle();
  check("moving onto the panel keeps it open", where, await isOpen(popover));
  await page.keyboard.press("Escape");
  check("Escape closes", where, !(await isOpen(popover)));
  check("Escape returns focus to the trigger", where, await focusIsOn(trigger));

  await away();
  await trigger.hover();
  await settle();
  await trigger.click();
  await away();
  await settle();
  check("a click pins it", where, await isOpen(popover));
  await page.keyboard.press("Escape");

  await trigger.hover();
  await settle();
  await away();
  await settle();
  check("leaving closes one that wasn't clicked", where, !(await isOpen(popover)));
}

// A popover left open with focus far away: Escape closes it and leaves the reader where they are.
async function checkEscapeStaysPut(page, where) {
  const popover = page.locator("#harness-plain .info-popover");
  await popover.locator("summary").click();
  await page.mouse.move(0, 0);
  const footerLink = page.locator("footer a").first();
  await footerLink.focus();
  const openHeight = (await popover.boundingBox()).height;
  const before = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("Escape");
  check("Escape closes from elsewhere", where, (await openCount(page)) === 0);
  check("Escape leaves focus elsewhere", where, await focusIsOn(footerLink));
  const moved = Math.abs((await page.evaluate(() => window.scrollY)) - before);
  // Closing a panel shortens the page, so at its foot the scroll can move by that much and no more.
  check("Escape doesn't jump the page", where, moved <= openHeight + 1, `${moved}px`);
}

async function checkTap(browser, origin, folder, markup, where, options) {
  const { context, page } = await openPage(browser, origin, folder, markup, {
    ...options,
    touch: true,
  });
  const triggers = page.locator("[data-harness] .info-popover > summary:visible");
  const first = triggers.nth(0);
  const firstPopover = first.locator("..");
  await first.tap();
  check("tap opens", where, await isOpen(firstPopover));
  await triggers.nth(1).tap();
  check("a second tap leaves one open", where, (await openCount(page)) === 1);
  await context.close();
}

async function checkToggle(page, where, width) {
  for (const [name, cardSelector] of [
    ["#harness-plain", "#harness-plain"],
    ...FILTERED_CARDS.map((box) => [box, `${box} > [data-chain-panel] > .chart-card:visible`]),
  ]) {
    const card = page.locator(cardSelector).first();
    const toggle = card.locator(".data-toggle");
    const summary = toggle.locator("> summary");
    const plot = card.locator(".chart-card__plot");
    const table = toggle.locator("table").first();
    const closedWidth = (await page.locator(name).boundingBox()).width;

    await summary.focus();
    await page.keyboard.press("Enter");
    check("the toggle swaps the chart for the table", where, !(await plot.isVisible()));
    check("the table shows", where, await table.isVisible());
    check(
      "the summary now says Chart",
      where,
      (await summary.innerText()).trim().startsWith("Chart"),
    );
    check("focus stays on the toggle", where, await focusIsOn(summary));
    check("notes stay visible", where, await card.locator("[data-pinned-notes]").isVisible());
    if (width >= TWO_COLUMNS_FROM) {
      const openWidth = (await page.locator(name).boundingBox()).width;
      check("an open toggle's card spans both columns", where, openWidth > closedWidth * 1.5);
    }

    await page.keyboard.press("Enter");
    check("the toggle swaps back", where, await plot.isVisible());
    check(
      "the summary says Table again",
      where,
      (await summary.innerText()).trim().startsWith("Table"),
    );
  }
}

async function checkTargets(page, where) {
  const small = await page.evaluate(
    ([minimum, filterMinimum]) => {
      const boxes = (selector) =>
        [...document.querySelectorAll(selector)]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => element.getBoundingClientRect());
      return [
        ...boxes(
          ".info-popover > summary, .data-toggle > summary, .trust-strip summary, [data-finding-link]",
        ).filter((box) => box.width < minimum || box.height < minimum),
        ...boxes(".chain-filter label").filter((box) => box.height < filterMinimum),
      ].length;
    },
    [MIN_TARGET, MIN_FILTER_TARGET],
  );
  check("targets are at least 24 px, and the filter's 36", where, small === 0, `${small} under`);
}

async function checkNoSidewaysScroll(page, where) {
  const values = await page
    .locator(".chain-filter input")
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("main details")) {
      details.removeAttribute("name");
      details.open = true;
    }
  });
  for (const [index, value] of values.entries()) {
    await page.locator(".chain-filter label").nth(index).click();
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(
      "no page scrolls sideways with every toggle open",
      where,
      over <= 0,
      `${value}: ${over}px`,
    );
    const outside = await page.evaluate((slack) => {
      const PARTS =
        ".hairline-table, .data-toggle__panel, .info-popover__panel, .pinned-notes, .chart-area";
      return [...document.querySelectorAll(".chart-card")]
        .filter((card) => card.checkVisibility())
        .flatMap((card) => {
          const box = card.getBoundingClientRect();
          return [...card.querySelectorAll(PARTS)]
            .filter((part) => part.checkVisibility())
            .filter((part) => {
              const inner = part.getBoundingClientRect();
              return inner.left < box.left - slack || inner.right > box.right + slack;
            })
            .map((part) => part.className || part.tagName);
        });
    }, BOX_SLACK_PX);
    check("every table and panel fits inside its card", where, outside.length === 0, `${outside}`);
  }
}

function checkAxeResults(where, state, violations) {
  const serious = violations.filter((rule) => ["serious", "critical"].includes(rule.impact));
  check(
    `axe finds nothing serious with toggles ${state}`,
    where,
    serious.length === 0,
    serious.map((rule) => `${rule.id}: ${rule.nodes.length}`).join(", "),
  );
}

// Contrast needs what a normal pass skips: the graphic, hidden from assistive tech but read by eyes,
// and the text beside the frame's edges. So this drops both, and only judges contrast.
async function checkContrast(page, where, state) {
  const style = await page.addStyleTag({ content: WITHOUT_FRAME_EDGES });
  await page.evaluate(() => {
    for (const area of document.querySelectorAll(".chart-area[aria-hidden]")) {
      area.removeAttribute("aria-hidden");
      area.dataset.wasHidden = "";
    }
  });
  const { violations, incomplete } = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    .analyze();
  await page.evaluate(() => {
    for (const area of document.querySelectorAll(".chart-area[data-was-hidden]")) {
      area.setAttribute("aria-hidden", "true");
      delete area.dataset.wasHidden;
    }
  });
  await style.evaluate((tag) => tag.remove());
  const failing = violations.flatMap((rule) => rule.nodes);
  check(
    `contrast passes in the graphic and beside the frame, toggles ${state}`,
    where,
    failing.length === 0,
    failing
      .slice(0, 4)
      .map((node) => node.target.join(" "))
      .join(", "),
  );
  return incomplete.flatMap((rule) => rule.nodes).length;
}

async function checkAxe(page, where) {
  const undetermined = {};
  const openToggles = (open) =>
    page.evaluate((value) => {
      for (const toggle of document.querySelectorAll(".data-toggle")) toggle.open = value;
    }, open);
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("main details:not(.data-toggle)")) {
      details.removeAttribute("name");
      details.open = true;
    }
  });
  for (const [state, open] of [
    ["closed", false],
    ["open", true],
  ]) {
    await openToggles(open);
    const { violations } = await new AxeBuilder({ page }).analyze();
    checkAxeResults(where, state, violations);
    undetermined[state] = await checkContrast(page, where, state);
  }
  undeterminedContrast.push(`${where}: ${undetermined.closed} closed, ${undetermined.open} open`);
}

async function checkWithoutJavaScript(page, where) {
  const note = page.locator(".chart-card__source-note:visible").first();
  check("source and definition show as a plain note", where, await note.isVisible());
  check("the note holds the source", where, (await note.innerText()).includes("Source:"));
  check("the note links the definition", where, (await note.locator("a").count()) === 1);
  const blank = await page.evaluate(
    () =>
      [...document.querySelectorAll(".chart-area")]
        .filter((area) => area.checkVisibility())
        .filter(
          (area) =>
            !area.textContent.trim() ||
            (area.querySelector(".recharts-responsive-container") &&
              !area.querySelector(".recharts-responsive-container svg")),
        )
        .filter((area) => {
          const note = area.parentElement.querySelector(".chart-area__needs-js");
          return !note?.checkVisibility();
        }).length,
  );
  check("an empty chart area has the note", where, blank === 0, `${blank} without`);
  // Each panel has its own, and the shown one is what counts.
  const needsJs = page.locator(".chart-area__needs-js:visible");
  check("the step line says it needs JavaScript", where, (await needsJs.count()) === 1);
  check("and the note is visible", where, await needsJs.isVisible());
  check("and points to the Table button", where, (await needsJs.innerText()).includes("The Table"));
  const kpiNotes = page.locator(".kpi-cell__note");
  check("each KPI's note shows in plain text", where, (await kpiNotes.count()) === 4);
  check(
    "and is visible, with its definition",
    where,
    (await kpiNotes.first().isVisible()) && (await kpiNotes.first().locator("a").count()) === 1,
  );
  const reading = page.locator(
    '[data-section="verdict"] noscript a, [data-section="verdict"] > p a',
  );
  check("the reading's definition shows in plain text", where, await reading.first().isVisible());
}

const boxOf = (page, selector) =>
  page.evaluate((target) => {
    const box = document.querySelector(target)?.getBoundingClientRect();
    if (!box) return null;
    // pageTop, for comparing two moments: a click can scroll the page between them.
    return {
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      pageTop: box.top + window.scrollY,
    };
  }, selector);

// Each finding lands on its card, with the card clear of the sticky header. A click with the filter
// on one chain goes back to All, as a finding speaks for every chain it covers.
async function checkFindingLinks(page, where, js) {
  const links = page.locator("[data-finding-link]");
  const total = await links.count();
  check("the page has four findings", where, total === 4, `${total}`);
  for (let index = 0; index < total; index += 1) {
    const link = links.nth(index);
    const href = await link.getAttribute("href");
    if (index === 0) {
      await link.focus();
      await page.keyboard.press("Enter");
    } else {
      await link.click();
    }
    await page.waitForFunction((target) => location.hash === target, href);
    const card = await boxOf(page, href);
    const header = await boxOf(page, "header");
    check(
      "a finding lands on its card, clear of the header",
      where,
      card !== null && card.top >= header.bottom - 1 && card.top < HEIGHT,
      `${href}: ${card ? Math.round(card.top) : "no card"}, header ${Math.round(header.bottom)}`,
    );
  }
  await page.evaluate(() => {
    history.replaceState(null, "", location.pathname);
    window.scrollTo(0, 0);
  });
  await page.locator(".chain-filter label").nth(1).click();
  check("the filter is off All", where, (await shownPanels(page))[0] !== "all");
  const supplyLink = links.first();
  const finding = (await supplyLink.locator(".finding__text").innerText()).trim();
  await supplyLink.click();
  await page.waitForFunction((target) => location.hash === target, SUPPLY);
  // With a script the filter goes back to All. Without one the targeted card shows All's panel.
  const landed = shownCard(page, SUPPLY);
  check(
    "a finding lands on a card that says the same, whatever the filter",
    where,
    (await landed.count()) === 1 && (await landed.locator("h2").innerText()).trim() === finding,
    await landed
      .locator("h2")
      .allInnerTexts()
      .then((texts) => texts.join(" | ")),
  );
  if (js) {
    check("a finding sets the filter to All", where, (await shownPanels(page))[0] === "all");
  }
  await page.locator(".chain-filter label").first().click();
  await page.evaluate(() => {
    history.replaceState(null, "", location.pathname);
    window.scrollTo(0, 0);
  });
}

// A popover on a KPI pushes what follows down, and hides nothing it leaves behind.
async function checkKpiPopover(page, where) {
  const trigger = page.locator('[data-section="kpi-row"] .info-popover > summary').nth(1);
  const before = await boxOf(page, '[data-section="findings"]');
  await trigger.click();
  await page.mouse.move(0, 0);
  const panel = page.locator('[data-section="kpi-row"] .info-popover[open] .info-popover__panel');
  check("a KPI's popover opens", where, await panel.isVisible());
  check(
    "and holds its definition",
    where,
    await panel.locator('a[href^="/methodology/#"]').isVisible(),
  );
  const after = await boxOf(page, '[data-section="findings"]');
  check("and pushes the findings down", where, after.pageTop > before.pageTop);
  check(
    "and every KPI value stays in view",
    where,
    await page.evaluate(() =>
      [...document.querySelectorAll("[data-kpi-value]")].every((value) => value.checkVisibility()),
    ),
  );
  await trigger.click();
  const closed = await boxOf(page, '[data-section="findings"]');
  check(
    "and closing it puts them back",
    where,
    Math.abs(closed.pageTop - before.pageTop) <= BOX_SLACK_PX,
  );
}

// The headline's popover holds verdict.text where the dataset lets it, and the rest in any case.
async function checkHeadlinePopover(page, where) {
  const popover = page.locator('[data-section="verdict"] .info-popover');
  await popover.locator("> summary").click();
  await page.mouse.move(0, 0);
  const panel = popover.locator(".info-popover__panel");
  check(
    "the headline's popover links its definition",
    where,
    await panel.locator('a[href="/methodology/#verdict"]').isVisible(),
  );
  const moved = await panel.locator("[data-verdict-text]").count();
  const real = (await page.evaluate(() => document.documentElement.dataset.datasetKind)) === "real";
  if (moved > 0) {
    check("verdict.text is in the popover only on real data", where, real);
    check("and it's readable there", where, await panel.locator("[data-verdict-text]").isVisible());
  }
  await popover.locator("> summary").click();
}

// The legend's trigger sits right after its last item at every width, and stays there as it opens.
async function checkLegendTrigger(page, where) {
  const legend = '[data-section="marker-legend"]';
  const trigger = `${legend} .info-popover > summary`;
  const last = await boxOf(page, `${legend} > p > span:last-child`);
  const closed = await boxOf(page, trigger);
  const gap = closed.left - last.right;
  check(
    "the legend's trigger sits right after its last item",
    where,
    gap >= 0 && gap <= LEGEND_TRIGGER_GAP && closed.top < last.bottom,
    `gap ${gap}`,
  );
  await page.locator(trigger).click();
  await page.mouse.move(0, 0);
  const open = await boxOf(page, trigger);
  check(
    "and it stays put as the legend opens",
    where,
    open.left === closed.left && open.pageTop === closed.pageTop,
  );
  await page.locator(trigger).click();
}

// The trust row's one disclosure opens under the row, and leaves the state in view above it.
async function checkTrustDisclosure(page, where, width) {
  const details = page.locator('[data-section="trust-strip"] details');
  check("the trust row has one disclosure", where, (await details.count()) === 1);
  const summary = details.locator("> summary");
  const status = '[data-section="trust-strip"] .trust-strip__status';
  const trigger = '[data-section="trust-strip"] details > summary';
  const before = await boxOf(page, status);
  const closedTrigger = await boxOf(page, trigger);
  await summary.click();
  check("it shows the table when open", where, await details.locator("table").first().isVisible());
  check(
    "it shows what it doesn't verify",
    where,
    (await details.innerText()).includes("doesn't verify placed share or velocity"),
  );
  const after = await boxOf(page, status);
  check(
    "the state stays where it was",
    where,
    Math.abs(after.pageTop - before.pageTop) <= BOX_SLACK_PX,
  );
  const panel = await boxOf(page, '[data-section="trust-strip"] details > div');
  check("the detail opens beneath the state", where, panel.top >= after.bottom - BOX_SLACK_PX);
  if (width >= BREAKPOINT_MD) {
    const openTrigger = await boxOf(page, trigger);
    check(
      "the trigger stays put as it opens",
      where,
      Math.abs(openTrigger.pageTop - closedTrigger.pageTop) <= BOX_SLACK_PX,
    );
  }
  await summary.click();
}

async function checkHeadlineLines(page, where, width, oneLine) {
  if (width < TWO_COLUMNS_FROM) return;
  const { text, lines } = await page.evaluate(() => {
    const heading = document.querySelector("h1");
    const { lineHeight } = getComputedStyle(heading);
    return {
      text: heading.textContent,
      lines: Math.round(heading.getBoundingClientRect().height / parseFloat(lineHeight)),
    };
  });
  if (text === oneLine) check("the usual headline fits one line from 1056", where, lines === 1);
}

// Only what the plan's fold says, on real data. Anything else is a build the fold doesn't speak for.
async function checkFold(browser, origin, where) {
  for (const { viewport, above, starts } of FOLDS) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const at = `${where} ${viewport.width}x${viewport.height}`;
    for (const name of above) {
      const box = await boxOf(page, `[data-section="${name}"]`);
      check(
        "above the fold on real data",
        at,
        box !== null && box.bottom <= viewport.height,
        `${name}: ${box ? Math.round(box.bottom) : "gone"}`,
      );
    }
    if (starts) {
      const box = await boxOf(page, `[data-section="${starts}"]`);
      check(
        "the next part starts above the fold",
        at,
        box !== null && box.top < viewport.height,
        `${starts}: ${box ? Math.round(box.top) : "gone"}`,
      );
    }
    await context.close();
  }
}

// Past its limit under a fake clock the page swaps both texts in place. Nothing above or below moves.
async function checkClockSwap(browser, origin, where, width) {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT } });
  const page = await context.newPage();
  await page.clock.install({ time: new Date() });
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const shown = () => page.evaluate(() => document.documentElement.dataset.freshness);
  if ((await shown()) !== "fresh") {
    notRun.add("the clock swap, on a build that's already stale, as it has nothing to swap");
    await context.close();
    return;
  }
  const layout = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "header, main, main [data-section], h1, .freshness-text, [data-kpi-value], [data-finding-link], footer",
        ),
      ].map((element) => {
        const box = element.getBoundingClientRect();
        return [box.top + window.scrollY, box.left, box.width, box.height].map(Math.round).join();
      }),
    );
  const swapped = () =>
    page.evaluate(() => {
      const seen = (selector) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element).visibility === "visible" : false;
      };
      return {
        verdict: seen('[data-section="verdict"] .freshness-text__stale'),
        trust: seen(
          '[data-section="trust-strip"] .trust-strip__status > .freshness-text .freshness-text__stale',
        ),
        freshGone: !seen('[data-section="verdict"] .freshness-text__fresh'),
      };
    });
  const before = await layout();
  check("the page starts on its fresh text", where, !(await swapped()).verdict);
  await page.clock.fastForward(CLOCK_JUMP_MS);
  await page.waitForFunction(() => document.documentElement.dataset.freshness === "stale");
  const { verdict, trust, freshGone } = await swapped();
  check("the as-of line swaps to its stale text", where, verdict && freshGone);
  check("the trust status swaps to its stale text", where, trust);
  const after = await layout();
  const moved = before.filter((box, index) => box !== after[index]).length;
  check("the swap moves nothing", where, moved === 0 && before.length > 0, `${moved} moved`);
  await context.close();
}

// Cards side by side from 1056, stacked below it, and the filter above them both. The two-column grid
// is what makes this a dashboard and the old stacked page wasn't, so it's measured, not assumed.
async function checkDashboardGrid(page, where, width) {
  const first = await boxOf(page, SUPPLY);
  const second = await boxOf(page, SERIES);
  const main = await boxOf(page, "main");
  const filter = await boxOf(page, ".dashboard .chain-filter");
  check(
    "the filter sits above the cards",
    where,
    filter !== null && filter.bottom <= Math.min(first.top, second.top) + BOX_SLACK_PX,
  );
  if (width >= TWO_COLUMNS_FROM) {
    check(
      "two cards share a row from 1056",
      where,
      Math.abs(first.top - second.top) <= 1 && second.left >= first.right,
      `tops ${Math.round(first.top)} and ${Math.round(second.top)}`,
    );
    const half = (main.right - main.left) / 2;
    check(
      "each takes half the page's width",
      where,
      first.right - first.left <= half && second.right - second.left <= half,
      `${Math.round(first.right - first.left)} of ${Math.round(half * 2)}`,
    );
    // The cards, not their panels' boxes, which a grid stretches whatever a card does.
    const firstCard = await shownCard(page, SUPPLY).boundingBox();
    const secondCard = await shownCard(page, SERIES).boundingBox();
    const endOf = (box) => box.y + box.height;
    check(
      "and they end together",
      where,
      Math.abs(endOf(firstCard) - endOf(secondCard)) <= 1,
      `${Math.round(endOf(firstCard))} and ${Math.round(endOf(secondCard))}`,
    );
  } else {
    check("cards stack below 1056", where, second.top >= first.bottom);
  }
}

// A card with room has its legend beside its chart. Measured on every filtered card, as the rule is
// what the maintainer asked for, and a narrower card keeps the legend directly under the chart.
async function checkLegendsBeside(page, where) {
  const found = await page.evaluate(
    ([slack, minimum]) => {
      const out = [];
      for (const card of document.querySelectorAll("[data-chain-panel] > .chart-card")) {
        if (!card.checkVisibility()) continue;
        const chart = card.querySelector(".chart-area")?.getBoundingClientRect();
        const legend = card.querySelector(".chart-legend")?.getBoundingClientRect();
        if (!chart || !legend) continue;
        const wide = card.getBoundingClientRect().width >= minimum;
        const overlap = Math.min(chart.bottom, legend.bottom) - Math.max(chart.top, legend.top);
        const beside = legend.left >= chart.right - slack && overlap > 0;
        const below = legend.top >= chart.bottom - slack;
        out.push({ wide, beside, below });
      }
      return out;
    },
    [BOX_SLACK_PX, NOTES_BESIDE_FROM],
  );
  // The supply cards have a legend beside their chart. The activity cards have none.
  check("the page has legends to check", where, found.length === 2);
  for (const { wide, beside, below } of found) {
    if (wide) check("a legend sits beside its chart from 560", where, beside);
    else check("a narrower card has its legend under the chart", where, below);
  }
}

// Sticky under the header from 768, in the flow below it. Either way an arriving card clears it.
async function checkStickyFilter(page, where, width) {
  const filter = ".dashboard .chain-filter";
  const sticks = width >= BREAKPOINT_MD;
  const start = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo({ top: 1600, behavior: "instant" }));
  const box = await boxOf(page, filter);
  const header = await boxOf(page, "header");
  if (sticks) {
    check(
      "the filter sticks under the header from 768",
      where,
      Math.abs(box.top - header.bottom) <= 1,
      `${Math.round(box.top)}, header ${Math.round(header.bottom)}`,
    );
    const onTop = await page.evaluate((selector) => {
      const option = document.querySelector(`${selector} label`).getBoundingClientRect();
      const at = document.elementFromPoint(
        option.left + option.width / 2,
        option.top + option.height / 2,
      );
      return Boolean(at?.closest(selector));
    }, filter);
    check("and no card covers it", where, onTop);
  } else {
    const position = await page.evaluate(
      (selector) => getComputedStyle(document.querySelector(selector)).position,
      filter,
    );
    check("the filter stays in the flow below 768", where, position === "static", position);
  }
  for (const id of Object.values(CARDS)) {
    await page.evaluate((target) => {
      location.hash = target;
    }, `#${id}`);
    const card = await boxOf(page, `#${id}`);
    const over = await boxOf(page, sticks ? filter : "header");
    const bar = await boxOf(page, "header");
    check(
      "an arriving card clears the header and the sticky filter",
      where,
      card.top >= over.bottom - 1 && card.top >= bar.bottom - 1 && card.top < HEIGHT,
      `#${id}: ${Math.round(card.top)}, ${Math.round(over.bottom)}`,
    );
  }
  await page.evaluate((top) => {
    history.replaceState(null, "", location.pathname);
    window.scrollTo({ top, behavior: "instant" });
  }, start);
}

// Choosing an option draws its step line at full width, and leaves the others as skeletons. Nothing
// above the grid moves, so a reader's place holds. Without a script the panel keeps its note.
async function checkStepLines(page, where, js) {
  const values = await page
    .locator(".chain-filter input")
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  const above = async () =>
    (await boxOf(page, '[data-section="marker-legend"]')).pageTop +
    (await boxOf(page, ".dashboard")).pageTop;
  const before = await above();
  for (const value of values) {
    await page.locator(`.chain-filter input[value="${value}"]`).check({ force: true });
    const panel = page.locator(`${SERIES} > [data-chain-panel="${value}"]`);
    if (js) {
      await panel.locator(".recharts-wrapper svg").first().waitFor();
      // The container, as a hidden panel's would draw nothing inside it even once it had mounted.
      const drawn = await page
        .locator(`${SERIES} .recharts-responsive-container`)
        .evaluateAll((charts) =>
          charts.map((chart) => chart.closest("[data-chain-panel]").dataset.chainPanel),
        );
      check("only the chosen panel mounts the chart", where, drawn.join() === value, `${drawn}`);
      const fits = await panel.locator(".chart-area").evaluate((area) => {
        const chart = area.querySelector(".recharts-wrapper").getBoundingClientRect();
        const box = area.getBoundingClientRect();
        return Math.abs(chart.width - box.width) <= 2 && box.width > 100 && chart.height > 100;
      });
      check("the step line draws at full width", where, fits, value);
    } else {
      check(
        "with no script, no panel mounts a chart",
        where,
        (await page.locator(`${SERIES} .recharts-responsive-container svg`).count()) === 0,
      );
    }
    check(
      "and nothing above the grid moves",
      where,
      Math.abs((await above()) - before) <= BOX_SLACK_PX,
      value,
    );
  }
  await page.locator(".chain-filter input").first().check({ force: true });
}

// What a reader sees of the supply card, under every option: each part at its share and each label
// whole, the band inside placed, a legend that doesn't jump, and every caveat in view.
async function checkSupplyOptions(page, where) {
  const values = await page
    .locator(".chain-filter input")
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  const legendRows = new Set();
  for (const value of values) {
    await page.locator(`.chain-filter input[value="${value}"]`).check({ force: true });
    const shown = await page.evaluate(
      ([box, chosen, slack]) => {
        const panel = document.querySelector(`${box} > [data-chain-panel="${chosen}"]`);
        const track = panel.querySelector(".supply-bar__track")?.getBoundingClientRect();
        const off = [];
        const clipped = [];
        let band = true;
        for (const part of panel.querySelectorAll("[data-part]")) {
          const rect = part.getBoundingClientRect();
          const want = (parseFloat(part.style.flexBasis) / 100) * track.width;
          if (Math.abs(rect.width - want) > 2) off.push(part.dataset.part);
          const label = part.querySelector('[data-testid="part-label"]');
          if (label) {
            const inner = label.getBoundingClientRect();
            const outside =
              inner.left < rect.left - slack ||
              inner.right > rect.right + slack ||
              inner.top < rect.top - slack ||
              inner.bottom > rect.bottom + slack;
            if (outside || label.scrollWidth > label.clientWidth + 1)
              clipped.push(part.dataset.part);
          }
          const mark = part.querySelector('[data-testid="exchange-linked-band"]');
          if (mark) {
            const inner = mark.getBoundingClientRect();
            band =
              part.dataset.part === "placed_supply" &&
              inner.width > 0 &&
              inner.width <= rect.width + slack &&
              inner.left >= rect.left - slack &&
              inner.right <= rect.right + slack;
          }
        }
        const bracket = panel.querySelector(".supply-bar__bracket > div")?.getBoundingClientRect();
        const firstCirculating = panel.querySelector(
          '[data-part="venue_dex"], [data-part="venue_lending"], [data-part="venue_exchange"], [data-part="free_floating"]',
        );
        const bracketFits =
          !bracket ||
          !firstCirculating ||
          Math.abs(bracket.left - firstCirculating.getBoundingClientRect().left) <= 2;
        // A chain with little circulating has a narrow bracket, and its word has to stay in the bar.
        const word = panel.querySelector(".supply-bar__bracket > span")?.getBoundingClientRect();
        const wordFits =
          !word || (word.left >= track.left - slack && word.right <= track.right + slack);
        const seen = (element) => element.checkVisibility();
        return {
          wordFits,
          off,
          clipped,
          band,
          bracketFits,
          rows: panel.querySelectorAll("[data-supply-legend] [data-segment]").length,
          bandRows: panel.querySelectorAll("[data-supply-legend] [data-band]").length,
          wallets: [...panel.querySelectorAll('[data-stat="active-wallets"]')].filter(seen).length,
          floor: panel.querySelectorAll('[data-note="exchange-floor"]').length,
        };
      },
      [SUPPLY, value, BOX_SLACK_PX],
    );
    check(
      "each part is drawn at its share",
      where,
      shown.off.length === 0,
      `${value}: ${shown.off}`,
    );
    check(
      "no direct label is clipped",
      where,
      shown.clipped.length === 0,
      `${value}: ${shown.clipped}`,
    );
    check("the band sits inside placed", where, shown.band, value);
    check("the bracket starts where circulating starts", where, shown.bracketFits, value);
    check("the bracket's word stays inside the bar", where, shown.wordFits, value);
    legendRows.add(`${shown.rows}+${shown.bandRows}`);
    check(
      "wallets show for one chain, and never summed",
      where,
      shown.wallets === (value === "all" ? 0 : 1),
      `${value}: ${shown.wallets}`,
    );
    check("every panel keeps the floor note", where, shown.floor === 1, value);
    await checkInView(page, `${where} on ${value}`);
    await checkLegendRows(page, `${where} on ${value}`);
  }
  check(
    "the legend doesn't jump between options",
    where,
    legendRows.size === 1,
    [...legendRows].join(),
  );
  await page.locator(".chain-filter input").first().check({ force: true });
}

// A legend row's figures clear its label, however long a floor is. Run under every option, as each
// option's amounts differ, and with a large floor wherever the data has one.
async function checkLegendRows(page, where) {
  const crowded = await page.evaluate((slack) => {
    const out = [];
    for (const row of document.querySelectorAll("[data-chain-panel] .chart-legend__row")) {
      if (!row.checkVisibility()) continue;
      const figures = row.querySelector(".chart-legend__values")?.getBoundingClientRect();
      const name = row.querySelector("[data-segment-label], .chart-legend__label > :first-child");
      if (!figures || !name) continue;
      const range = document.createRange();
      range.selectNodeContents(name);
      const clash = [...range.getClientRects()].some(
        (line) =>
          line.right > figures.left + slack &&
          line.left < figures.right - slack &&
          line.bottom > figures.top + slack &&
          line.top < figures.bottom - slack,
      );
      const box = row.getBoundingClientRect();
      if (clash || figures.right > box.right + slack) out.push(row.textContent.slice(0, 40));
    }
    return out;
  }, BOX_SLACK_PX);
  check("a legend row's figures clear its label", where, crowded.length === 0, crowded.join(" | "));
}

// An open table may wrap an amount anywhere, and never a chain's name or a heading inside a word.
async function checkTableWords(page, where) {
  const toggle = page.locator(`${SUPPLY} > [data-chain-panel="all"] .data-toggle`);
  await toggle.locator("> summary").click();
  const split = await toggle
    .locator("table")
    .first()
    .evaluate((table) => {
      const broken = [];
      for (const cell of table.querySelectorAll("thead th, tbody td:first-child")) {
        // The first cell's name, in either layout: a stacked one prints its label by CSS, beside it.
        const range = document.createRange();
        range.selectNodeContents(cell);
        const lineTops = new Set([...range.getClientRects()].map((line) => Math.round(line.top)));
        // A hyphen is a fair place to wrap, as "Free-floating" does.
        const words = cell.textContent.trim().split(/[\s-]+/).length;
        if (lineTops.size > words) broken.push(cell.textContent.trim());
      }
      return broken;
    });
  check(
    "an open table breaks no name or heading inside a word",
    where,
    split.length === 0,
    split.join(),
  );
  await toggle.locator("> summary").click();
}

// A row may sit under the toggle, so opening it has to show every one of them, whole.
async function checkExchangeRowsOpen(page, where) {
  const toggle = page.locator(`${SUPPLY} > [data-chain-panel="all"] .data-toggle`);
  await toggle.locator("> summary").click();
  const rows = toggle.locator("[data-exchange-row]");
  const total = await rows.count();
  check("the toggle holds the exchange rows", where, total > 0, `${total}`);
  for (let index = 0; index < total; index += 1) {
    const row = rows.nth(index);
    const parts = ["[data-exchange-name]", "[data-exchange-detail]", "a[data-exchange-source]"];
    const seen = await Promise.all(parts.map((part) => row.locator(part).isVisible()));
    check("an open toggle shows each exchange row whole", where, seen.every(Boolean), `${index}`);
  }
  const notes = await page
    .locator(`${SUPPLY} > [data-chain-panel="all"] [data-note="exchange-floor"]`)
    .isVisible();
  check("and the floor note stays in view beside them", where, notes);
  await toggle.locator("> summary").click();
}

// The activity cards under each option: the waterfall reads top to bottom with its hatching and
// every label and figure inside its card, a pin sits on its row, and a week's figure stays over its
// own bar, so a narrow panel can't run one into the next.
async function checkActivityOptions(page, where) {
  const values = await page
    .locator(".chain-filter input")
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  for (const value of values) {
    await page.locator(`.chain-filter input[value="${value}"]`).check({ force: true });
    const seen = await page.evaluate((chosen) => {
      const waterfall = document.querySelector(
        `#headline-to-clean > [data-chain-panel="${chosen}"] .chart-card`,
      );
      const weekly = document.querySelector(
        `#everyday-by-week > [data-chain-panel="${chosen}"] .chart-card`,
      );
      const card = waterfall.getBoundingClientRect();
      const rows = [...waterfall.querySelectorAll(".chart-area [data-step]")];
      const tops = rows.map((row) => row.getBoundingClientRect().top);
      const outside = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.left < card.left || rect.right > card.right + 0.5;
      });
      const unknown = !waterfall.querySelector(".chart-area [data-step]");
      const removals = rows.filter(
        (row) => !["headline_value", "clean_large", "clean_everyday"].includes(row.dataset.step),
      );
      const pins = [...waterfall.querySelectorAll(".chart-area .pin")];
      const numbersWhole = [...weekly.querySelectorAll("[data-week-number]")].every((number) => {
        const range = document.createRange();
        range.selectNodeContents(number);
        const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        return tops.size === 1;
      });
      const hatched = rows
        .filter(
          (row) => !["headline_value", "clean_large", "clean_everyday"].includes(row.dataset.step),
        )
        .every((row) =>
          getComputedStyle(row.querySelector("[data-bar]")).backgroundImage.includes("gradient"),
        );
      const pinsOnRows = pins.every(
        (pin) => pin.closest("[data-step]") && pin.closest("[aria-hidden='true']"),
      );
      const figures = [...weekly.querySelectorAll("[data-week]")].map((week) => {
        const own = week.getBoundingClientRect();
        const text = week.querySelector("[data-week-value]").getBoundingClientRect();
        return text.left >= own.left - 0.5 && text.right <= own.right + 0.5;
      });
      return {
        unknown,
        removals: removals.length,
        pins: pins.length,
        numbersWhole,
        rows: rows.length,
        ordered: tops.every((top, index) => index === 0 || top > tops[index - 1]),
        outside: outside.map((row) => row.dataset.step),
        hatched,
        pinsOnRows,
        figuresInside: figures.every(Boolean),
        weeks: figures.length,
      };
    }, value);
    // Unknown data draws no rows, and then there's nothing for these checks to read.
    if (!seen.unknown) {
      check("the waterfall has its twelve rows", where, seen.rows === 12, `${value}: ${seen.rows}`);
      check(
        "the waterfall's removals and pins are there to check",
        where,
        seen.removals === 9 && seen.pins > 0,
        value,
      );
    }
    check("the waterfall reads top to bottom", where, seen.unknown || seen.ordered, value);
    check("a week's number never breaks across lines", where, seen.numbersWhole, value);
    check(
      "every waterfall row fits its card",
      where,
      seen.outside.length === 0,
      `${value}: ${seen.outside}`,
    );
    check("the removals are hatched", where, seen.hatched, value);
    check(
      "the waterfall's pins sit on their rows, hidden from assistive tech",
      where,
      seen.pinsOnRows,
      value,
    );
    check("each week's figure stays over its own bar", where, seen.figuresInside, value);
  }
  await page.locator(`.chain-filter input[value="${values[0]}"]`).check({ force: true });
}

async function checkFolder(browser, folder, harness, widths) {
  const partial = basename(folder) === "partial";
  const chains = partial ? ["tempo", "ethereum"] : ["tempo", "ethereum", "base", "solana"];
  const { markup } = harness;
  const server = await serve(folder);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const real = readFileSync(join(folder, "index.html"), "utf8").includes(
    'data-dataset-kind="real"',
  );
  if (real) {
    await guarded("the fold", basename(folder), () => checkFold(browser, origin, basename(folder)));
    realFolders += 1;
  }
  for (const width of widths) {
    for (const js of [true, false]) {
      const where = `${basename(folder)} ${width} js ${js ? "on" : "off"}`;
      const options = { width, js };
      const { context, page, errors } = await openPage(browser, origin, folder, markup, options);
      const group = (name, run) => guarded(name, where, run);
      await group("in view", () => checkInView(page, where));
      await group("focus", () => checkFocusRings(page, where));
      await group("the headline's lines", () =>
        checkHeadlineLines(page, where, width, harness.oneLineHeadline),
      );
      await group("the filter", () => checkFilter(page, where, js, chains));
      await group("the grid", () => checkDashboardGrid(page, where, width));
      await group("legends beside", () => checkLegendsBeside(page, where));
      await group("the sticky filter", () => checkStickyFilter(page, where, width));
      await group("the supply card", () => checkSupplyOptions(page, where));
      await group("the step lines", () => checkStepLines(page, where, js));
      await group("the activity cards", () => checkActivityOptions(page, where));
      await group("the exchange rows", () => checkExchangeRowsOpen(page, where));
      await group("the table's words", () => checkTableWords(page, where));
      await group("the findings", () => checkFindingLinks(page, where, js));
      await group("a KPI's popover", () => checkKpiPopover(page, where));
      await group("the headline's popover", () => checkHeadlinePopover(page, where));
      await group("the legend's trigger", () => checkLegendTrigger(page, where));
      await group("the trust row", () => checkTrustDisclosure(page, where, width));
      await group("one at a time", () => checkOneAtATime(page, where));
      await group("nothing covered", () => checkNothingCovered(page, where));
      if (js) await group("hover", () => checkHover(page, where));
      if (js) await group("Escape", () => checkEscapeStaysPut(page, where));
      if (!js) await group("no script", () => checkWithoutJavaScript(page, where));
      await group("the toggle", () => checkToggle(page, where, width));
      await group("targets", () => checkTargets(page, where));
      await group("sideways scroll", () => checkNoSidewaysScroll(page, where));
      if (js && AXE_WIDTHS.has(width)) await group("axe", () => checkAxe(page, where));
      check("no console errors", where, errors.length === 0, errors.slice(0, 3).join(" | "));
      await context.close();
      if (js) {
        await guarded("the clock swap", where, () => checkClockSwap(browser, origin, where, width));
      }
      await guarded("tap", where, () => checkTap(browser, origin, folder, markup, where, options));
      await guarded("methodology", where, () => checkMethodologyPage(browser, origin, where, js));
      await guarded("forced colours", where, () =>
        checkForcedColors(browser, origin, folder, markup, where, options),
      );
      await guarded("no :has()", where, () =>
        checkWithoutHas(browser, origin, folder, markup, chains, where, options),
      );
    }
  }
  server.close();
}

let realFolders = 0;
const args = process.argv.slice(2);
const widthsArg = args.find((arg) => arg.startsWith("--widths="));
const widths = widthsArg ? widthsArg.slice("--widths=".length).split(",").map(Number) : ALL_WIDTHS;
const folders = args.filter((arg) => !arg.startsWith("--")).map((folder) => resolve(folder));
if (folders.length === 0) {
  folders.push(join(WEB_DIR, ".build/complete"), join(WEB_DIR, ".build/partial"));
}
for (const folder of folders) {
  if (!existsSync(join(folder, "index.html"))) {
    console.error(`No built site at ${basename(folder)}. Build it first, with: make web-samples`);
    process.exit(2);
  }
}

const harness = await loadHarness();
const browser = await launch();
try {
  for (const folder of folders) await checkFolder(browser, folder, harness, widths);
} finally {
  await browser.close();
  await harness.close();
}

for (const [name, { pass, fail }] of counts)
  console.log(`${fail ? "FAIL" : "ok  "} ${pass}/${pass + fail} ${name}`);
// Not a pass or a fail: what axe couldn't judge, such as text on the hatched fills.
for (const line of undeterminedContrast) console.log(`Contrast axe couldn't judge, ${line}`);
if (realFolders === 0) notRun.add("the fold, as no folder holds real data");
for (const reason of notRun) console.log(`Not run: ${reason}`);
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(
  `${failures.length === 0 ? "Passed" : "Failed"}: ${counts.size} checks, ${failures.length} failures.`,
);
process.exit(failures.length > 0 ? 1 : 0);
