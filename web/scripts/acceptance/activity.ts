import type { Page } from "playwright";
import { check } from "./report.ts";

// The activity cards under each option: the waterfall reads top to bottom with its hatching and
// every label and figure inside its card, a pin sits on its row, and a week's figure stays over its
// own bar, so a narrow panel can't run one into the next.
export async function checkActivityOptions(page: Page, where: string) {
  const values = await page
    .locator(".chain-filter input")
    .evaluateAll((inputs: HTMLInputElement[]) => inputs.map((input) => input.value));
  for (const value of values) {
    await page.locator(`.chain-filter input[value="${value}"]`).check({ force: true });
    const seen = await page.evaluate((chosen) => {
      const waterfall = document.querySelector(
        `#headline-to-clean > [data-chain-panel="${chosen}"] .chart-card`,
      )!;
      const weekly = document.querySelector(
        `#everyday-by-week > [data-chain-panel="${chosen}"] .chart-card`,
      )!;
      const card = waterfall.getBoundingClientRect();
      const rows = [...waterfall.querySelectorAll<HTMLElement>(".chart-area [data-step]")];
      const tops = rows.map((row) => row.getBoundingClientRect().top);
      const outside = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.left < card.left || rect.right > card.right + 0.5;
      });
      const unknown = !waterfall.querySelector(".chart-area [data-step]");
      const removals = rows.filter(
        (row) =>
          !["headline_value", "clean_large", "clean_everyday"].includes(row.dataset.step as string),
      );
      // A badge sits on the row it qualifies, or by the title.
      const pins = [...waterfall.querySelectorAll("a[data-fn-ref]")].filter(
        (marker) => !marker.closest("[data-step], .chart-card__head"),
      );
      const numbersWhole = [...weekly.querySelectorAll("[data-week-number]")].every((number) => {
        const range = document.createRange();
        range.selectNodeContents(number);
        const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        return tops.size === 1;
      });
      const hatched = rows
        .filter(
          (row) =>
            !["headline_value", "clean_large", "clean_everyday"].includes(
              row.dataset.step as string,
            ),
        )
        .every((row) =>
          getComputedStyle(row.querySelector("[data-bar]")!).backgroundImage.includes("gradient"),
        );
      const figures = [...weekly.querySelectorAll("[data-week]")].map((week) => {
        const own = week.getBoundingClientRect();
        const text = week.querySelector("[data-week-value]")!.getBoundingClientRect();
        return text.left >= own.left - 0.5 && text.right <= own.right + 0.5;
      });
      return {
        unknown,
        removals: removals.length,
        pins: pins.length,
        notes: waterfall.querySelectorAll("a[data-fn-ref]").length,
        numbersWhole,
        rows: rows.length,
        ordered: tops.every((top, index) => index === 0 || top > tops[index - 1]),
        outside: outside.map((row) => row.dataset.step),
        hatched,
        figuresInside: figures.every(Boolean),
        weeks: figures.length,
      };
    }, value);
    // Unknown data draws no rows, and then there's nothing for these checks to read.
    if (!seen.unknown) {
      check("the waterfall has its twelve rows", where, seen.rows === 12, `${value}: ${seen.rows}`);
      check(
        "the waterfall's removals and footnote markers are there to check",
        where,
        seen.removals === 9 && seen.notes > 0,
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
    check("each waterfall marker sits on its row or the title", where, seen.pins === 0, value);
    check("each week's figure stays over its own bar", where, seen.figuresInside, value);
  }
  await page.locator(`.chain-filter input[value="${values[0]}"]`).check({ force: true });
}

// The cards that compare chains: under each option the chosen chain is marked by weight and a rule,
// and no other is, nothing fades, and both cards fit inside themselves at every width.
export async function checkChainCards(page: Page, where: string) {
  const values = await page
    .locator(".chain-filter input")
    .evaluateAll((inputs: HTMLInputElement[]) => inputs.map((input) => input.value));
  for (const value of values) {
    await page.locator(`.chain-filter input[value="${value}"]`).check({ force: true });
    const seen = await page.evaluate((chosen) => {
      const marked = (element: Element) => {
        const style = getComputedStyle(element);
        const rule =
          style.boxShadow !== "none" ||
          (style.borderLeftStyle !== "none" &&
            style.borderLeftColor !== "rgba(0, 0, 0, 0)" &&
            parseFloat(style.borderLeftWidth) > 0);
        return Number(style.fontWeight) >= 600 && rule;
      };
      const names = [...document.querySelectorAll<HTMLElement>("[data-velocity-chain]")].map(
        (group) => ({
          chain: group.dataset.velocityChain,
          marked: marked(group.querySelector(".velocity-chart__name")!),
        }),
      );
      const cells = [
        ...document.querySelectorAll<HTMLElement>(".chain-grid td[data-grid-chain]"),
      ].map((cell) => ({ chain: cell.dataset.gridChain, marked: marked(cell) }));
      const faded = [
        ...document.querySelectorAll("#velocity-by-chain *, #what-each-chain-does *"),
      ].filter((element) => Number(getComputedStyle(element).opacity) < 1).length;
      const spill = ["velocity-by-chain", "what-each-chain-does"].filter((id) => {
        const card = document.getElementById(id)!.getBoundingClientRect();
        return [
          ...document.getElementById(id)!.querySelectorAll("table, td, th, .velocity-chart"),
        ].some((element) => element.getBoundingClientRect().right > card.right + 0.5);
      });
      const right = (list: { chain: string | undefined; marked: boolean }[]) =>
        list.length > 0 && list.every(({ chain, marked: on }) => on === (chain === chosen));
      return { names: right(names), cells: right(cells), faded, spill };
    }, value);
    check("the velocity chart marks only the chosen chain", where, seen.names, value);
    check("the chain grid marks only the chosen chain", where, seen.cells, value);
    check("nothing on the chain cards fades", where, seen.faded === 0, `${value}: ${seen.faded}`);
    check(
      "both chain cards fit inside themselves",
      where,
      seen.spill.length === 0,
      `${value}: ${seen.spill}`,
    );
  }
  await page.locator(`.chain-filter input[value="${values[0]}"]`).check({ force: true });
}
