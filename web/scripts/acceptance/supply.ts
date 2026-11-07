import type { Page } from "playwright";
import { BOX_SLACK_PX } from "./constants.ts";
import { check } from "./report.ts";
import { SERIES, SUPPLY, SUPPLY_CARD, boxOf } from "./session.ts";
import { checkInView } from "./layout.ts";

// Choosing an option draws its step line at full width, and leaves the others as skeletons. Nothing
// above the grid moves, so a reader's place holds. Without a script the panel keeps its note.
export async function checkStepLines(page: Page, where: string, js: boolean) {
  const values = await page
    .locator(".chain-filter input")
    .evaluateAll((inputs: HTMLInputElement[]) => inputs.map((input) => input.value));
  const above = async () =>
    (await boxOf(page, '[data-section="kpi-row"]'))!.pageTop +
    (await boxOf(page, ".dashboard"))!.pageTop;
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
          charts.map(
            (chart) => chart.closest<HTMLElement>("[data-chain-panel]")!.dataset.chainPanel,
          ),
        );
      check("only the chosen panel mounts the chart", where, drawn.join() === value, `${drawn}`);
      const fits = await panel.locator(".chart-area").evaluate((area) => {
        const chart = area.querySelector(".recharts-wrapper")!.getBoundingClientRect();
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

// What a reader sees of the supply card: every chain's bar at once, each part at its share and each
// label whole, the band inside placed, and the bracket on the first. Under every option the legend
// and caveats stay, the heading names the chosen chain, and its bar is marked by weight and a rule.
// Only the other chains' bars fade, never a word, so contrast holds.
export async function checkSupplyOptions(page: Page, where: string) {
  const values = await page
    .locator(".chain-filter input")
    .evaluateAll((inputs: HTMLInputElement[]) => inputs.map((input) => input.value));
  const legendRows = new Set();
  for (const value of values) {
    await page.locator(`.chain-filter input[value="${value}"]`).check({ force: true });
    const shown = await page.evaluate(
      ([box, chosen, slack]: [string, string, number]) => {
        const card = document.querySelector<HTMLElement>(
          `${box} > [data-chain-panel="${chosen}"]`,
        )!;
        const panel = card.querySelector<HTMLElement>(`[data-supply-row="${chosen}"]`)!;
        const heading = card.querySelector(".chart-card__head h2")!.textContent!;
        const label = panel.querySelector(".supply-row__name")!.textContent!;
        const style = getComputedStyle(panel);
        const name = getComputedStyle(panel.querySelector(".supply-row__name")!);
        const marked =
          parseFloat(style.borderLeftWidth) > 0 &&
          style.borderLeftColor !== "rgba(0, 0, 0, 0)" &&
          Number(name.fontWeight) >= 600;
        const others = [...card.querySelectorAll<HTMLElement>("[data-supply-row]")].filter(
          (row) =>
            row !== panel &&
            row.dataset.supplyRow !== "all" &&
            getComputedStyle(row).borderLeftColor !== "rgba(0, 0, 0, 0)",
        ).length;
        const muted = [
          ...card.querySelectorAll("[data-supply-row][data-muted] .supply-bar__track"),
        ];
        const faded = [...card.querySelectorAll("*")].filter(
          (element) => Number(getComputedStyle(element).opacity) < 1 && !muted.includes(element),
        ).length;
        const mutedRight =
          chosen === "all"
            ? muted.length === 0
            : muted.length === card.querySelectorAll("[data-supply-row]").length - 1 &&
              muted.every((bar) => Number(getComputedStyle(bar).opacity) < 1);
        const track = panel.querySelector(".supply-bar__track")?.getBoundingClientRect() as DOMRect;
        const off: (string | undefined)[] = [];
        const clipped: (string | undefined)[] = [];
        let band = true;
        for (const part of panel.querySelectorAll<HTMLElement>("[data-part]")) {
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
        const seen = (element: Element) => element.checkVisibility();
        return {
          wordFits,
          off,
          clipped,
          band,
          bracketFits,
          marked: chosen === "all" || marked,
          named: chosen === "all" || heading.includes(`of ${label} supply`),
          others,
          faded,
          mutedRight,
          rows: card.querySelectorAll("[data-supply-legend] [data-segment]").length,
          bandRows: card.querySelectorAll("[data-supply-legend] [data-band]").length,
          wallets: [...card.querySelectorAll('[data-stat="active-wallets"]')].filter(seen).length,
          floor: card.querySelectorAll('.footnotes__list > [data-note="exchange-floor"]').length,
        };
      },
      [SUPPLY, value, BOX_SLACK_PX] as [string, string, number],
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
      "wallets are never summed beside the bars, and a chain's own count shows on its card",
      where,
      shown.wallets === (value === "all" ? 0 : 1),
      value,
    );
    check("the heading names the chosen chain", where, shown.named, value);
    check("only the other chains' bars are muted", where, shown.mutedRight, value);
    check("the card keeps the floor note", where, shown.floor === 1, value);
    check("the chosen chain's bar is marked", where, shown.marked, value);
    check("and no other is", where, shown.others === 0, `${value}: ${shown.others}`);
    check(
      "nothing else on the supply card fades",
      where,
      shown.faded === 0,
      `${value}: ${shown.faded}`,
    );
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
async function checkLegendRows(page: Page, where: string) {
  const crowded = await page.evaluate((slack) => {
    const out = [];
    for (const row of document.querySelectorAll(".dashboard .chart-legend__row")) {
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
export async function checkTableWords(page: Page, where: string) {
  const toggle = page.locator(SUPPLY_CARD).locator(".data-toggle");
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
export async function checkExchangeRowsOpen(page: Page, where: string) {
  const card = page.locator(SUPPLY_CARD);
  const toggle = card.locator(".data-toggle");
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
  const notes =
    (await card.locator(".footnotes > summary").isVisible()) &&
    (await card.locator('.footnotes__list > [data-note="exchange-floor"]').count()) === 1;
  check("and the floor note is in the footnotes, a tap away beside them", where, notes);
  await toggle.locator("> summary").click();
}
