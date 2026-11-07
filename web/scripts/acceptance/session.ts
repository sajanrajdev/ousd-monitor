import type { Page, Browser, Locator } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DRAWER_SETTLE_MS, HEIGHT, STEP_TIMEOUT_MS } from "./constants.ts";

// The enhancer marks the page root once it has taken the tooltips over from the CSS fallback.
async function enhancerReady(page: Page) {
  await page.waitForFunction(() => document.documentElement.dataset.tips === "on");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// Swaps the two @supports conditions in the built CSS, so Chromium applies what a browser without
// :has() would. Rules using :has() outside those blocks don't change what the filter or toggle do.
async function behaveWithoutHas(page: Page) {
  await page.route("**/*.css", async (route) => {
    const response = await route.fetch();
    const css = (await response.text())
      .replaceAll("not selector(:has(*))", "SUPPORTED")
      .replaceAll("selector(:has(*))", "not selector(html)")
      .replaceAll("SUPPORTED", "selector(html)");
    await route.fulfill({ response, body: css });
  });
}

export type OpenOptions = {
  width: number;
  js: boolean;
  touch?: boolean;
  forcedColors?: "none" | "active";
  withoutHas?: boolean;
};

export async function openPage(
  browser: Browser,
  origin: string,
  folder: string,
  markup: string,
  { width, js, touch = false, forcedColors = "none", withoutHas = false }: OpenOptions,
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
  const errors: string[] = [];
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
      document.querySelector("main")!.insertAdjacentHTML("beforeend", html);
    }, markup);
  }
  return { context, page, errors };
}

export const shownPanels = (page: Page) =>
  page.$$eval("[data-chain-panel]", (panels) =>
    (panels as HTMLElement[])
      .filter((panel) => panel.getClientRects().length > 0)
      .map((panel) => panel.dataset.chainPanel),
  );

// The cards a filter option changes, so each check covers every one of them. The supply card keeps
// every chain's bar under each option, and marks the chosen one.
export const FILTERED_CARDS = [
  "#where-supply-sits",
  "#placed-vs-circulating",
  "#headline-to-clean",
  "#everyday-by-week",
];

export const SUPPLY = "#where-supply-sits";

// The supply card the filter shows. Each check that reads it starts on All.
export const SUPPLY_CARD = `${SUPPLY} > [data-chain-panel] > .chart-card:visible`;

export const SERIES = "#placed-vs-circulating";

// Open is drawn: with a script that's data-open, and without one it's :hover or :focus-within.
export const openCount = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll("[data-tip] > .tip__panel")].filter((panel) =>
        panel.checkVisibility(),
      ).length,
  );

export const isOpen = (locator: Locator) =>
  locator.evaluate((tip) => tip.querySelector(":scope > .tip__panel")!.checkVisibility());

// A tooltip and its trigger, on the harness card that no filter hides.
export const HARNESS_TIP = "#harness-plain .chart-card__head > .tip--info";

export const focusIsOn = (locator: Locator) =>
  locator.evaluate((element) => document.activeElement === element);

export const boxOf = (page: Page, selector: string) =>
  page.evaluate((target: string) => {
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

// An element's colour and its contrast with the page.
export function colourOf(locator: Locator) {
  return locator.evaluate((element) => {
    const channels = (value: string) =>
      value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number);
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((channel: number) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const text = channels(getComputedStyle(element).color);
    const page = channels(getComputedStyle(document.body).backgroundColor);
    const [light, dark] = [luminance(text), luminance(page)].sort((a, b) => b - a);
    return { color: text, contrast: (light + 0.05) / (dark + 0.05) };
  });
}

// Waits for the drawer, and then for the page to stop scrolling.
export async function settle(page: Page) {
  await page.waitForTimeout(DRAWER_SETTLE_MS);
  let last = -1;
  for (let tries = 0; tries < 20; tries += 1) {
    const y = await page.evaluate(() => window.scrollY);
    if (y === last) return;
    last = y;
    await page.waitForTimeout(100);
  }
}
