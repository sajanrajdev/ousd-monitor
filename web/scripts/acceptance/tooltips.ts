import type { Page, Browser } from "playwright";
import { BOX_SLACK_PX, HOVER_SETTLE_MS } from "./constants.ts";
import { check } from "./report.ts";
import {
  HARNESS_TIP,
  boxOf,
  focusIsOn,
  isOpen,
  openCount,
  openPage,
  type OpenOptions,
} from "./session.ts";

// One open at a time. Focus opens a tooltip, Enter keeps it, and Enter again closes it.
export async function checkOneAtATime(page: Page, where: string, js: boolean) {
  const triggers = page.locator("[data-harness] .tip__icon:visible");
  await triggers.nth(0).click();
  await triggers.nth(1).click();
  check("one tooltip opens at a time", where, (await openCount(page)) === 1);
  await triggers.nth(1).click();
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await triggers.nth(0).focus();
  check("keyboard focus opens a tooltip", where, (await openCount(page)) === 1);
  await page.keyboard.press("Enter");
  check("Enter keeps it open", where, (await openCount(page)) === 1);
  await page.keyboard.press("Enter");
  // With no script there's nothing to toggle it, and it stays while it has focus.
  if (js) check("Enter again closes it", where, (await openCount(page)) === 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// A tooltip floats: opening one moves nothing on the page, and its panel stays inside the viewport.
// Each is opened by keyboard focus, as a reader would, and its links can be reached from there.
export async function checkFloating(page: Page, where: string, js: boolean) {
  const results = await page.evaluate(() => {
    const WATCHED =
      ".chart-area, .hairline-table, .fn-refs, .footnotes > summary, .chart-card__meta, .chart-card h2, .chart-card h3, .data-toggle > summary, h1, .freshness-text, [data-verdict-text], [data-kpi-value], [data-section='kpi-row'] dt, [data-section='kpi-row'] > p, footer";
    // What a hidden filter panel holds has no box, so it can't move, whatever the scroll does.
    const layout = () =>
      [...document.querySelectorAll(WATCHED)].map((element) => {
        // What's in a tooltip shows only while it's open, so it's the panel and not the page.
        if (element.closest(".tip__panel") || element.getClientRects().length === 0)
          return "hidden";
        const box = element.getBoundingClientRect();
        return `${Math.round(box.top + window.scrollY)},${Math.round(box.left)},${Math.round(box.height)}`;
      });
    const width = document.documentElement.clientWidth;
    const out = [];
    for (const tip of document.querySelectorAll("[data-tip]")) {
      const trigger = tip.querySelector<HTMLElement>(":scope > .tip__trigger")!;
      // A hidden filter panel's tooltip has no box to check.
      if (!trigger.checkVisibility()) continue;
      const before = layout();
      trigger.focus({ preventScroll: false });
      const panel = tip.querySelector<HTMLElement>(":scope > .tip__panel")!;
      const box = panel.getBoundingClientRect();
      const after = layout();
      const moved = before.filter((value, index) => value !== after[index]).length;
      // A link inside a sentence keeps its line, as WCAG 2.5.8 exempts it. One that stands alone doesn't.
      const small = [...panel.querySelectorAll("a")]
        .filter(
          (link) =>
            link.classList.contains("target-link") ||
            link.parentElement!.textContent.trim() === link.textContent.trim(),
        )
        .filter((link) => link.getBoundingClientRect().height < 24).length;
      out.push({
        name: trigger.getAttribute("aria-label") ?? trigger.textContent!.slice(0, 30),
        open: panel.checkVisibility(),
        inside: box.left >= -0.5 && box.right <= width + 0.5,
        moved,
        small,
      });
      trigger.blur();
    }
    return out;
  });
  check("the page has tooltips to check", where, results.length > 0);
  for (const { name, open, inside, moved, small } of results) {
    check("keyboard focus opens each tooltip", where, open, name);
    check("an open tooltip moves nothing on the page", where, moved === 0, `${name}: ${moved}`);
    // The enhancer keeps a panel inside the viewport. With no script nothing can measure it, so it
    // only has to open.
    if (js) check("an open tooltip stays inside the viewport", where, inside, name);
    check("a link in a tooltip is at least 24 px", where, small === 0, name);
  }
}

export async function checkHover(page: Page, where: string) {
  const tip = page.locator(HARNESS_TIP);
  const trigger = tip.locator("> .tip__trigger");
  const panel = tip.locator("> .tip__panel");
  const away = () => page.mouse.move(0, 0);
  const settle = () => page.waitForTimeout(HOVER_SETTLE_MS);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await away();
  await settle();
  check("no tooltip is open before a hover", where, (await openCount(page)) === 0);
  await trigger.hover();
  await settle();
  check("hover opens", where, await isOpen(tip), `${await openCount(page)} open`);
  check("the open tooltip is drawn", where, await panel.isVisible());
  await panel.hover();
  await settle();
  check("moving onto the panel keeps it open", where, await isOpen(tip));
  await page.keyboard.press("Escape");
  check("Escape closes", where, !(await isOpen(tip)));
  check("and hides it, under the pointer", where, !(await panel.isVisible()));

  await away();
  await trigger.hover();
  await settle();
  await trigger.click();
  await away();
  await settle();
  check("a click pins it", where, await isOpen(tip));
  await page.keyboard.press("Escape");
  check("Escape closes a pinned one", where, !(await isOpen(tip)));
  check("Escape leaves focus on the trigger", where, await focusIsOn(trigger));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await trigger.hover();
  await settle();
  await away();
  await settle();
  check("leaving closes one that wasn't clicked", where, !(await isOpen(tip)));
}

// A tooltip open under the pointer with focus far away: Escape closes it, leaves focus where it is
// and doesn't move the page, as the panel took no room.
export async function checkEscapeStaysPut(page: Page, where: string) {
  const trigger = page.locator(`${HARNESS_TIP} > .tip__trigger`);
  await trigger.hover();
  await page.waitForTimeout(HOVER_SETTLE_MS);
  const footerLink = page.locator("footer nav a").first();
  await footerLink.evaluate((link) => link.focus({ preventScroll: true }));
  check("a tooltip is open to close", where, (await openCount(page)) === 1);
  const before = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("Escape");
  check("Escape closes from elsewhere", where, (await openCount(page)) === 0);
  check("Escape leaves focus elsewhere", where, await focusIsOn(footerLink));
  const moved = Math.abs((await page.evaluate(() => window.scrollY)) - before);
  check("Escape doesn't jump the page", where, moved === 0, `${moved}px`);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// On a touch screen a tap toggles a tooltip, and one stays open at a time.
export async function checkTap(
  browser: Browser,
  origin: string,
  folder: string,
  markup: string,
  where: string,
  options: OpenOptions,
) {
  const { context, page } = await openPage(browser, origin, folder, markup, {
    ...options,
    touch: true,
  });
  const tips = page.locator("[data-harness] .chart-card__head > .tip--info:visible");
  await tips.nth(0).locator("> .tip__trigger").tap();
  check("tap opens", where, await isOpen(tips.nth(0)));
  await tips.nth(1).locator("> .tip__trigger").tap();
  check("a tap on another leaves one open", where, (await openCount(page)) === 1);
  await tips.nth(1).locator("> .tip__trigger").tap();
  if (options.js) check("a second tap closes it", where, (await openCount(page)) === 0);
  await context.close();
}

// A KPI's tooltip floats over the page: it holds the definition, moves nothing, and hides no value.
export async function checkKpiTooltip(page: Page, where: string) {
  const tip = page.locator('[data-section="kpi-row"] [data-tip]').nth(1);
  const next = '[data-section="kpi-row"] + *, .dashboard';
  const before = await boxOf(page, next);
  await tip.locator("> .tip__trigger").click();
  await page.mouse.move(0, 0);
  const panel = tip.locator("> .tip__panel");
  check("a KPI's tooltip opens", where, await panel.isVisible());
  check(
    "and holds its definition",
    where,
    await panel.locator('a[href^="/methodology/#"]').isVisible(),
  );
  const after = await boxOf(page, next);
  check(
    "and moves nothing below it",
    where,
    Math.abs(after!.pageTop - before!.pageTop) <= BOX_SLACK_PX,
  );
  check(
    "and every KPI value stays drawn",
    where,
    await page.evaluate(() =>
      [...document.querySelectorAll("[data-kpi-value]")].every((value) => value.checkVisibility()),
    ),
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// "How we read this" is a "?" beside the headline that opens a tooltip, which holds verdict.text
// where the dataset lets it, and the rest in any case, with the link to how the reading is made.
export async function checkHeadlineTooltip(page: Page, where: string) {
  const tip = page.locator('[data-section="verdict"] [data-tip]');
  const trigger = tip.locator("> .tip__trigger");
  check(
    "the reading's trigger is a ? named How we read this",
    where,
    (await trigger.getAttribute("aria-label")) === "How we read this" &&
      (await trigger.innerText()).trim() === "",
    await trigger.innerText(),
  );
  const [line, mark] = await page.evaluate(() => {
    const h1 = document.querySelector('[data-section="verdict"] h1')!.getClientRects();
    const icon = document
      .querySelector('[data-section="verdict"] .tip__icon')!
      .getBoundingClientRect();
    const last = h1[h1.length - 1];
    return [last.top + last.height / 2, icon.top + icon.height / 2];
  });
  // At the 320 px reflow width the "?" may take a line of its own, as the headline fills its lines.
  if (page.viewportSize()!.width >= 390) {
    check("and it sits on the headline's last line", where, Math.abs(line - mark) < 16);
  }
  await trigger.hover();
  await page.waitForTimeout(HOVER_SETTLE_MS);
  check("hovering it opens how we read this", where, await isOpen(tip));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(HOVER_SETTLE_MS);
  await trigger.click();
  await page.mouse.move(0, 0);
  const panel = tip.locator("> .tip__panel");
  check(
    "the reading's tooltip links its definition",
    where,
    await panel.locator('a[href="/methodology/#verdict"]').isVisible(),
  );
  const moved = await panel.locator("[data-verdict-text]").count();
  const real = (await page.evaluate(() => document.documentElement.dataset.datasetKind)) === "real";
  if (moved > 0) {
    check("verdict.text is in the tooltip only on real data", where, real);
    check("and it's readable there", where, await panel.locator("[data-verdict-text]").isVisible());
  }
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}
