import type { Page, Browser } from "playwright";
import { CLOCK_JUMP_MS, HEIGHT, HOVER_SETTLE_MS } from "./constants.ts";
import { check, notRun } from "./report.ts";
import { colourOf, isOpen } from "./session.ts";
import { checkInView } from "./layout.ts";

export async function checkMethodologyPage(
  browser: Browser,
  origin: string,
  where: string,
  js: boolean,
) {
  const context = await browser.newContext({ javaScriptEnabled: js });
  const page = await context.newPage();
  await page.goto(`${origin}/methodology/`, { waitUntil: "networkidle" });
  await checkInView(page, `${where} methodology`);
  await context.close();
}

// The reconciliation detail is its own page. A build that passed says "Reconciled" in the footer, in
// green with a tick, with the dated sentence as a tooltip on hover and focus. Any other keeps the
// trust row at the top, and its footer never says "Reconciled".
export async function checkReconciliation(page: Page, where: string) {
  const passing = await page.evaluate(
    () =>
      document.documentElement.dataset.datasetKind === "real" &&
      document.documentElement.dataset.freshness === "fresh" &&
      document.querySelector("footer [data-reconciled]") !== null,
  );
  const word = page.locator("footer [data-reconciled]");
  const strip = page.locator('[data-section="trust-strip"]');
  check(
    "the main page has no reconciliation disclosure",
    where,
    (await page.locator('[data-section="trust-strip"] details').count()) === 0,
  );
  const kind = await page.evaluate(() => document.documentElement.dataset.datasetKind);
  if (!passing) {
    const footer = await page.locator("footer [data-footer-status]").innerText();
    check("its footer never says Reconciled", where, !/\bReconciled\b/.test(footer), footer);
    if (kind !== "real") {
      check(
        "sample or preview data keeps the trust row at the top",
        where,
        await strip.isVisible(),
      );
      return;
    }
    // Old real data: the footer's amber clock and "Last reconciled" with the day, and the line
    // under the headline says only when the data is from. A failed newer run keeps its top row.
    const clock = page.locator("footer [data-stale-status]");
    check(
      "the footer shows a clock and Last reconciled",
      where,
      (await clock.isVisible()) &&
        /^Last reconciled \d{1,2} [A-Z][a-z]{2,3}$/.test((await clock.innerText()).trim()),
      await clock.innerText(),
    );
    const icon = await colourOf(clock.locator("svg"));
    check(
      "the clock is amber",
      where,
      icon.color[0] > icon.color[1] && icon.color[1] > icon.color[2],
      `${icon.color}`,
    );
    check("and meets 3:1", where, icon.contrast >= 3, icon.contrast.toFixed(2));
    await clock.locator("a").hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    check(
      "hovering it shows the full sentence",
      where,
      (await clock.locator("[data-tip] > .tip__panel").innerText()).startsWith("Last reconciled "),
    );
    await page.mouse.move(0, 0);
    await page.waitForTimeout(HOVER_SETTLE_MS);
    if ((await strip.count()) === 0) {
      const asOf = await page
        .locator('[data-section="verdict"] > .verdict-block__as-of')
        .first()
        .innerText();
      check(
        "and the line under the headline says only when the data is from",
        where,
        /^Data from [^.]+\.$/.test(asOf.trim()),
        asOf,
      );
    }
    return;
  }
  check("a build that passed has no trust row at the top", where, (await strip.count()) === 0);
  check(
    "the footer says Reconciled, with a tick",
    where,
    (await word.innerText()).trim() === "Reconciled" && (await word.locator("svg").count()) === 1,
    await word.innerText(),
  );
  const { color, contrast } = await colourOf(word);
  check("and it's green", where, color[1] > color[0] && color[1] > color[2], `${color}`);
  check("and meets 4.5:1", where, contrast >= 4.5, contrast.toFixed(2));
  const link = word.locator("a");
  const tip = word.locator("[data-tip]");
  await link.focus();
  check("focusing it shows the full sentence", where, await isOpen(tip));
  check(
    "which is the dated sentence",
    where,
    (await tip.locator("> .tip__panel").innerText()).startsWith("Supply reconciled on all"),
  );
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await link.hover();
  await page.waitForTimeout(HOVER_SETTLE_MS);
  check("hovering it shows the full sentence", where, await isOpen(tip));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(HOVER_SETTLE_MS);
}

// The detail's own page: the table, what it doesn't verify, and a clear way back to the dashboard.
export async function checkReconciliationPage(
  browser: Browser,
  origin: string,
  where: string,
  js: boolean,
) {
  const context = await browser.newContext({ javaScriptEnabled: js });
  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page
    .locator('footer [data-footer-status] a[href="/reconciliation/"]:visible')
    .first()
    .click();
  await page.waitForURL(`${origin}/reconciliation/`);
  const detail = page.locator('[data-section="reconciliation"]');
  check("the footer's status leads to /reconciliation/", where, await detail.isVisible());
  const text = await detail.innerText();
  check(
    "it says what it doesn't check",
    where,
    text.includes("doesn't check placed share or velocity"),
  );
  check(
    "one status line under the title, and each check with its result",
    where,
    (await detail.locator("[data-run-line]").isVisible()) &&
      (await detail.locator("[data-check-list] > div").count()) > 0,
  );
  check(
    "it has the table, or says there's none",
    where,
    (await detail.locator("table").count()) === 1 || text.includes("Not enough data yet"),
  );
  check("it keeps the normal header", where, await page.locator("header").isVisible());
  const back = page.getByRole("link", { name: "Back to the dashboard", exact: true });
  // A sample or preview banner may sit between the header and the page, so it's measured from main.
  const [arrow, title, top] = await Promise.all(
    [back, page.locator("main h1"), page.locator("main")].map((element) => element.boundingBox()),
  );
  check("it has a way back to the dashboard", where, await back.isVisible());
  check(
    "an arrow above the title, which is at the top of the page",
    where,
    arrow!.y + arrow!.height <= title!.y + 4 && title!.y - top!.y < 80,
    `${Math.round(title!.y - top!.y)}px`,
  );
  await back.click();
  await page.waitForURL(`${origin}/`);
  check(
    "which leads back to it",
    where,
    await page.locator('[data-section="verdict"]').isVisible(),
  );
  await page.goto(`${origin}/reconciliation/`, { waitUntil: "networkidle" });
  await checkInView(page, `${where} reconciliation`);
  await context.close();
}

// Past its limit under a fake clock the page swaps both texts in place. Nothing above or below moves.
export async function checkClockSwap(
  browser: Browser,
  origin: string,
  where: string,
  width: number,
) {
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
          // Everything above the footer, which is last, so its status swaps outright.
          "header, main, main [data-section], h1, main .freshness-text, [data-kpi-value]",
        ),
      ].map((element) => {
        const box = element.getBoundingClientRect();
        return [box.top + window.scrollY, box.left, box.width, box.height].map(Math.round).join();
      }),
    );
  const swapped = () =>
    page.evaluate(() => {
      const seen = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element).visibility === "visible" : false;
      };
      return {
        verdict: seen('[data-section="verdict"] .freshness-text__stale'),
        // A build that passed has no trust row at the top: its footer status swaps instead.
        trust: seen(
          '[data-section="trust-strip"] .trust-strip__status > .freshness-text .freshness-text__stale, footer [data-footer-status] .freshness-text__stale',
        ),
        reconciledGone: !seen("footer [data-reconciled]"),
        freshGone: !seen('[data-section="verdict"] .freshness-text__fresh'),
      };
    });
  const before = await layout();
  check("the page starts on its fresh text", where, !(await swapped()).verdict);
  await page.clock.fastForward(CLOCK_JUMP_MS);
  await page.waitForFunction(() => document.documentElement.dataset.freshness === "stale");
  const { verdict, trust, freshGone, reconciledGone } = await swapped();
  check("the as-of line swaps to its stale text", where, verdict && freshGone);
  check("the trust status swaps to its stale text", where, trust);
  check("and the footer no longer says Reconciled", where, reconciledGone);
  const after = await layout();
  const moved = before.filter((box, index) => box !== after[index]).length;
  check("the swap moves nothing", where, moved === 0 && before.length > 0, `${moved} moved`);
  await context.close();
}
