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

const counts = new Map();
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
  const card = (name, props) =>
    h(
      ChartCard,
      {
        takeaway: `A made-up finding about ${name}`,
        chip: "inferred",
        source: "Made-up data",
        asOf: "2026-11-03",
        definitionHref: "/methodology/#velocity",
        frameWord: "Sample",
        summary: `A made-up summary of ${name}.`,
        notes: [{ kind: "harness", text: `On ${name}, a made-up caveat.` }],
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
      h(Pin, { number: 1 }),
    );
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

async function openPage(browser, origin, folder, markup, { width, js, touch = false }) {
  const context = await browser.newContext({
    viewport: { width, height: HEIGHT },
    javaScriptEnabled: js,
    hasTouch: touch,
  });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  const page = await context.newPage();
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
  }
}

async function checkAxe(page, where) {
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  const serious = violations.filter((rule) => ["serious", "critical"].includes(rule.impact));
  check(
    "axe finds nothing serious with everything open",
    where,
    serious.length === 0,
    serious.map((rule) => `${rule.id}: ${rule.nodes.length}`).join(", "),
  );
}

async function checkWithoutJavaScript(page, where) {
  const note = page.locator(".chart-card__source-note").first();
  check("source and definition show as a plain note", where, await note.isVisible());
  check("the note holds the source", where, (await note.innerText()).includes("Source:"));
  check("the note links the definition", where, (await note.locator("a").count()) === 1);
  const needsJs = page.locator(".chart-area__needs-js");
  check("the step line says it needs JavaScript", where, (await needsJs.count()) === 1);
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
      await group("the filter", () => checkFilter(page, where, js, chains));
      await group("one at a time", () => checkOneAtATime(page, where));
      await group("nothing covered", () => checkNothingCovered(page, where));
      if (js) await group("hover", () => checkHover(page, where));
      if (!js) await group("no script", () => checkWithoutJavaScript(page, where));
      await group("the toggle", () => checkToggle(page, where, width));
      await group("targets", () => checkTargets(page, where));
      await group("sideways scroll", () => checkNoSidewaysScroll(page, where));
      if (js && AXE_WIDTHS.has(width)) await group("axe", () => checkAxe(page, where));
      check("no console errors", where, errors.length === 0, errors.slice(0, 3).join(" | "));
      await context.close();
      await guarded("tap", where, () => checkTap(browser, origin, folder, markup, where, options));
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
for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(
  `${failures.length === 0 ? "Passed" : "Failed"}: ${counts.size} checks, ${failures.length} failures.`,
);
process.exit(failures.length > 0 ? 1 : 0);
