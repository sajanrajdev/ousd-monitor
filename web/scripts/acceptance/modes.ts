import type { Page, Browser } from "playwright";
import { check } from "./report.ts";
import {
  FILTERED_CARDS,
  HARNESS_TIP,
  SERIES,
  isOpen,
  openPage,
  shownPanels,
  type OpenOptions,
} from "./session.ts";
import { chosenOptionDiffers } from "./filter.ts";

// Forced colours drop backgrounds, so the chosen option and open trigger need their own rule.
export async function checkForcedColors(
  browser: Browser,
  origin: string,
  folder: string,
  markup: string,
  where: string,
  options: OpenOptions,
) {
  const { context, page } = await openPage(browser, origin, folder, markup, {
    ...options,
    forcedColors: "active",
  });
  check("the chosen option shows in forced colours", where, await chosenOptionDiffers(page));
  const trigger = page.locator(`${HARNESS_TIP} > .tip__icon`);
  const before = await trigger.evaluate((element) => getComputedStyle(element).backgroundColor);
  await trigger.click();
  const after = await trigger.evaluate((element) => getComputedStyle(element).backgroundColor);
  check("an open trigger shows in forced colours", where, before !== after);
  const edge = await page
    .locator(`${HARNESS_TIP} > .tip__panel`)
    .evaluate((panel) => getComputedStyle(panel).borderTopStyle);
  check("an open tooltip keeps its edge in forced colours", where, edge !== "none", edge);
  await context.close();
}

// Long but complete: no filter that can do nothing, every panel, and a toggle that doesn't say Chart.
export async function checkWithoutHas(
  browser: Browser,
  origin: string,
  folder: string,
  markup: string,
  chains: string[],
  where: string,
  options: OpenOptions,
) {
  const { context, page } = await openPage(browser, origin, folder, markup, {
    ...options,
    withoutHas: true,
  });
  await context.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...query: string[]) =>
      String(query[0]).includes(":has(")
        ? false
        : supports(...(query as [string, string]))) as typeof CSS.supports;
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
      document.querySelector("main")!.insertAdjacentHTML("beforeend", html);
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

export async function checkWithoutJavaScript(page: Page, where: string) {
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
          const note = area.parentElement!.querySelector(".chart-area__needs-js");
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
  // With no script, CSS opens a tooltip on focus and on hover, so its content is still reached.
  const tip = page.locator(HARNESS_TIP);
  await tip.locator("> .tip__trigger").focus();
  check("with no script, focus opens a tooltip", where, await isOpen(tip));
  await page.keyboard.press("Tab");
  const inside = await tip.evaluate((element) => element.contains(document.activeElement));
  check("and Tab reaches the link inside it", where, inside);
  check("and it stays open while focus is in it", where, await isOpen(tip));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await tip.locator("> .tip__trigger").hover();
  check("with no script, hover opens a tooltip", where, await isOpen(tip));
  await page.mouse.move(0, 0);
}
