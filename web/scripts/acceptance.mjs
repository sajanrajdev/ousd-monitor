// Local only, and never run by `make check`. Reaches the built site in a real browser, with what a
// unit test can't see: layout, focus, hover, touch and the native behaviour with JavaScript off.
// Each unit adds its checks. Usage: acceptance.mjs [built folder ...], by default both samples.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { launch, serve } from "./local-browser.mjs";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const WIDTHS = [320, 390, 768, 1056, 1440];
const AXE_WIDTHS = new Set([390, 1440]);
const HEIGHT = 900;
const TWO_COLUMNS_FROM = 1056;
const MIN_TARGET = 24;
const MIN_FILTER_TARGET = 36;
// Longer than the enhancer's hover delays, so a panel has had the chance to change.
const HOVER_SETTLE_MS = 500;
const STEP_TIMEOUT_MS = 5000;
const BOX_SLACK_PX = 0.5;
// The frame's hatched edges are pseudo-elements, which leave axe unable to judge the text near them.
const WITHOUT_FRAME_EDGES = `html[data-frame] body::before, html[data-frame] body::after,
  .chart-card[data-frame]::before { content: none !important; }`;

const counts = new Map();
const undeterminedContrast = [];
const failures = [];

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

// The filter and legend aren't on the page yet, and no page has the two-column grid. So this renders
// the real components with made-up amounts, and puts them in the built page, where the real CSS and
// enhancer apply. Drop each part as a later unit mounts the real thing.
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
  const [{ ChainFilter }, { ChainPanels }, { ChartCard }, { MarkerLegend }, { Pin }, scope] =
    await Promise.all([
      load("/components/chain-filter.tsx"),
      load("/components/chain-panels.tsx"),
      load("/components/chart-card.tsx"),
      load("/components/marker-legend.tsx"),
      load("/components/pinned-notes.tsx"),
      load("/lib/chain-scope.ts"),
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
  const markup = (chains) => {
    const options = scope.chainOptions(chains);
    return renderToStaticMarkup(
      h(
        "section",
        { "data-harness": "" },
        h(MarkerLegend),
        h(ChainFilter, { options }),
        h(
          "div",
          { className: "card-grid" },
          h(ChainPanels, { options, id: "harness-panels" }, (option) => card(option.label)),
          card("no filter", { id: "harness-plain" }),
        ),
      ),
      { identifierPrefix: "harness-" },
    );
  };
  return { markup, close: () => vite.close() };
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
  check("the filter lists only chains in the data", where, values.length === chains.length + 1);
  check("the chosen option looks different", where, await chosenOptionDiffers(page));
  for (const [index, value] of values.entries()) {
    await page.locator(".chain-filter label").nth(index).click();
    const shown = await shownPanels(page);
    check(
      "choosing a filter shows one panel",
      where,
      shown.length === 1 && shown[0] === value,
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
  check(
    "the right arrow moves to the next option",
    where,
    (await shownPanels(page))[0] === values[1],
  );
  await page.keyboard.press("ArrowLeft");
  check("the left arrow moves back", where, (await shownPanels(page))[0] === values[0]);
}

// What must be in view with nothing opened. A stylesheet can hide what verify-output can't read.
async function checkInView(page, where) {
  const missing = await page.evaluate(() => {
    const seen = (element) => {
      if (!element?.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
      const box = element.getBoundingClientRect();
      return box.width > 1 && box.height > 1;
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
      need("the headline", verdict.querySelector("h1"));
      need("the headline's marker", verdict.querySelector('.status-chip[data-kind="opinion"]'));
      const when = [...verdict.querySelectorAll(".freshness-text > *")];
      if (!when.some(seen)) lacking.push("the as-of line");
      const trust = document.querySelectorAll('[data-section="trust-strip"] .freshness-text > *');
      if (![...trust].some(seen)) lacking.push("the trust status");
      for (const value of document.querySelectorAll("[data-kpi-value]")) need("a KPI value", value);
      for (const chip of document.querySelectorAll('[data-section="kpi-row"] .status-chip')) {
        need("a KPI marker", chip.querySelector("[aria-hidden]") ?? chip);
      }
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
  check(
    "without :has(), the filter is hidden",
    where,
    !(await page.locator(".chain-filter").isVisible()),
  );
  const shown = await shownPanels(page);
  check("without :has(), every panel shows", where, shown.length === chains.length + 1, `${shown}`);
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
  const triggers = page.locator("[data-harness] .info-popover > summary");
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
      ".chart-area, .hairline-table, .pinned-notes > li, .chart-card__meta, .chart-card h2, .chart-card h3, .status-chip, .data-toggle > summary, [data-section='kpi-row'] > *";
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
  await trigger.hover();
  await settle();
  check("hover opens", where, await isOpen(popover));
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
  const popovers = page.locator("[data-harness] .info-popover");
  await popovers.nth(0).locator("summary").tap();
  check("tap opens", where, await isOpen(popovers.nth(0)));
  await popovers.nth(1).locator("summary").tap();
  check("a second tap leaves one open", where, (await openCount(page)) === 1);
  await context.close();
}

async function checkToggle(page, where, width) {
  for (const [name, cardSelector] of [
    ["#harness-plain", "#harness-plain"],
    ["#harness-panels", "#harness-panels .chart-card:visible"],
  ]) {
    const card = page.locator(cardSelector).first();
    const toggle = card.locator(".data-toggle");
    const summary = toggle.locator("> summary");
    const plot = card.locator(".chart-card__plot");
    const table = toggle.locator("table");
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
        ...boxes(".info-popover > summary, .data-toggle > summary").filter(
          (box) => box.width < minimum || box.height < minimum,
        ),
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
  const note = page.locator(".chart-card__source-note").first();
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
  const needsJs = page.locator(".chart-area__needs-js");
  check("the step line says it needs JavaScript", where, (await needsJs.count()) === 1);
  check("and the note is visible", where, await needsJs.isVisible());
  check("and points to the Table button", where, (await needsJs.innerText()).includes("The Table"));
}

async function checkFolder(browser, folder, harness) {
  const partial = basename(folder) === "partial";
  const chains = partial ? ["tempo", "solana"] : ["tempo", "ethereum", "base", "solana"];
  const markup = harness.markup(chains);
  const server = await serve(folder);
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const width of WIDTHS) {
    for (const js of [true, false]) {
      const where = `${basename(folder)} ${width} js ${js ? "on" : "off"}`;
      const options = { width, js };
      const { context, page, errors } = await openPage(browser, origin, folder, markup, options);
      const group = (name, run) => guarded(name, where, run);
      await group("in view", () => checkInView(page, where));
      await group("focus", () => checkFocusRings(page, where));
      await group("the filter", () => checkFilter(page, where, js, chains));
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

const folders = process.argv.slice(2).map((folder) => resolve(folder));
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
  for (const folder of folders) await checkFolder(browser, folder, harness);
} finally {
  await browser.close();
  await harness.close();
}

for (const [name, { pass, fail }] of counts)
  console.log(`${fail ? "FAIL" : "ok  "} ${pass}/${pass + fail} ${name}`);
// Not a pass or a fail: what axe couldn't judge, such as text on the hatched fills.
for (const line of undeterminedContrast) console.log(`Contrast axe couldn't judge, ${line}`);
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(
  `${failures.length === 0 ? "Passed" : "Failed"}: ${counts.size} checks, ${failures.length} failures.`,
);
process.exit(failures.length > 0 ? 1 : 0);
