import type { Page } from "playwright";
import { BREAKPOINT_MD, CARDS, HEIGHT } from "./constants.ts";
import { check } from "./report.ts";
import { FILTERED_CARDS, boxOf, shownPanels } from "./session.ts";

export const chosenOptionDiffers = (page: Page) =>
  page.evaluate(() => {
    const look = (selector: string) => {
      const { backgroundColor, color } = getComputedStyle(document.querySelector(selector)!);
      return `${backgroundColor} ${color}`;
    };
    return (
      look(".chain-filter input:checked + span") !==
      look(".chain-filter input:not(:checked) + span")
    );
  });

export async function checkFilter(page: Page, where: string, js: boolean, chains: string[]) {
  const radios = page.locator(".chain-filter input");
  const values = await radios.evaluateAll((inputs: HTMLInputElement[]) =>
    inputs.map((input) => input.value),
  );
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
      check("the status line says what's showing", where, status!.startsWith("Showing "));
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

// Sticky under the header from 768, in the flow below it. Either way an arriving card clears it.
export async function checkStickyFilter(page: Page, where: string, width: number) {
  const filter = ".dashboard .chain-filter";
  const sticks = width >= BREAKPOINT_MD;
  const start = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo({ top: 1600, behavior: "instant" }));
  const box = (await boxOf(page, filter))!;
  const header = (await boxOf(page, "header"))!;
  if (sticks) {
    check(
      "the filter sticks under the header from 768",
      where,
      Math.abs(box.top - header.bottom) <= 1,
      `${Math.round(box.top)}, header ${Math.round(header.bottom)}`,
    );
    const onTop = await page.evaluate((selector) => {
      const option = document.querySelector(`${selector} label`)!.getBoundingClientRect();
      const at = document.elementFromPoint(
        option.left + option.width / 2,
        option.top + option.height / 2,
      );
      return Boolean(at?.closest(selector));
    }, filter);
    check("and no card covers it", where, onTop);
  } else {
    const position = await page.evaluate(
      (selector: string) => getComputedStyle(document.querySelector(selector)!).position,
      filter,
    );
    check("the filter stays in the flow below 768", where, position === "static", position);
  }
  for (const id of Object.values(CARDS)) {
    await page.evaluate((target) => {
      location.hash = target;
    }, `#${id}`);
    const card = (await boxOf(page, `#${id}`))!;
    const over = (await boxOf(page, sticks ? filter : "header"))!;
    const bar = (await boxOf(page, "header"))!;
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
