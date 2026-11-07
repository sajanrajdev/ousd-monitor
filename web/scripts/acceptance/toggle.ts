import type { Page } from "playwright";
import { CARDS, DRAWER_SETTLE_MS, HEIGHT } from "./constants.ts";
import { check } from "./report.ts";
import { FILTERED_CARDS, SUPPLY, SUPPLY_CARD, focusIsOn, settle } from "./session.ts";

// Every card's toggle sits at its top right, just left of the info icon on the title row, and keeps
// that box, to the pixel, whether it says Table or Chart.
export async function checkToggle(page: Page, where: string) {
  for (const [name, cardSelector] of [
    ["#harness-plain", "#harness-plain"],
    ...FILTERED_CARDS.map((box) => [box, `${box} > [data-chain-panel] > .chart-card:visible`]),
    ...[CARDS.velocity, CARDS.chainRoles].map((id) => [`#${id}`, `#${id}`]),
  ]) {
    const card = page.locator(cardSelector).first();
    const toggle = card.locator(".data-toggle");
    const summary = toggle.locator("> summary");
    const plot = card.locator(".chart-card__plot");
    const table = toggle.locator("table").first();
    const closedWidth = (await page.locator(name).boundingBox())!.width;

    await summary.focus();
    const place = () =>
      summary.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const icon = element
          .closest(".chart-card")!
          .querySelector(":scope > .chart-card__head > .tip--info")!
          .getBoundingClientRect();
        return {
          box: [box.left, box.top, box.width, box.height].map((value) => Math.round(value)),
          beside: box.right <= icon.left && box.right >= icon.left - 16,
          level: box.top < icon.bottom && box.bottom > icon.top,
        };
      });
    const closed = await place();
    check(
      "the toggle sits on the title row, just left of the info icon",
      where,
      closed.beside && closed.level,
      name,
    );
    await page.keyboard.press("Enter");
    const opened = await place();
    check(
      "the toggle keeps its box when it opens",
      where,
      opened.box.join() === closed.box.join(),
      `${name}: ${closed.box} to ${opened.box}`,
    );
    check("the toggle swaps the chart for the table", where, !(await plot.isVisible()));
    check("the table shows", where, await table.isVisible());
    check(
      "the summary now says Chart",
      where,
      (await summary.innerText()).trim().startsWith("Chart"),
    );
    check("focus stays on the toggle", where, await focusIsOn(summary));
    // The footnotes stay one tap away while the table shows.
    if ((await card.locator(".footnotes").count()) > 0) {
      check(
        "the Footnotes toggle stays in view",
        where,
        await card.locator(".footnotes > summary").isVisible(),
      );
    }
    const openWidth = (await page.locator(name).boundingBox())!.width;
    check("an open toggle's card keeps its width", where, Math.abs(openWidth - closedWidth) <= 1);

    await page.keyboard.press("Enter");
    const shut = await place();
    check(
      "and when it closes",
      where,
      shut.box.join() === closed.box.join(),
      `${name}: ${closed.box} to ${shut.box}`,
    );
    check("the toggle swaps back", where, await plot.isVisible());
    check(
      "the summary says Table again",
      where,
      (await summary.innerText()).trim().startsWith("Table"),
    );
  }
}

// A card's footnotes: closed at first, opened by keyboard on its toggle, with or without a script,
// as a list whose numbers match the markers, which a marker also opens, landing on its footnote.
export async function checkFootnotes(page: Page, where: string, js: boolean) {
  const card = page.locator(SUPPLY_CARD);
  const details = card.locator(".footnotes");
  const summary = details.locator("> summary");
  const list = details.locator(".footnotes__list");
  await summary.scrollIntoViewIfNeeded();
  check("a card's footnotes start closed", where, !(await list.isVisible()));
  const [summaryBox, asOfBox] = await Promise.all([
    summary.boundingBox(),
    card.locator(".chart-card__meta").boundingBox(),
  ]);
  check(
    "its Footnotes toggle is on the row with the as-of date, at the right",
    where,
    Math.abs(summaryBox!.y + summaryBox!.height / 2 - (asOfBox!.y + asOfBox!.height / 2)) < 8 &&
      summaryBox!.x > asOfBox!.x,
  );
  await summary.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(DRAWER_SETTLE_MS);
  check("Enter on Footnotes opens the list", where, await list.isVisible());
  const [listBox, openSummary] = await Promise.all([list.boundingBox(), summary.boundingBox()]);
  check("which opens below the card's content", where, listBox!.y > openSummary!.y);
  const numbers = await card.evaluate((element) => {
    const items = [...element.querySelectorAll(".footnotes__list > li")];
    return items.map((item, index) => {
      const marker = element.querySelector(`a[data-fn-ref][href="#${item.id}"]`);
      return marker?.textContent.trim() === String(index + 1);
    });
  });
  check(
    "every footnote's number matches its marker",
    where,
    numbers.length > 0 && numbers.every(Boolean),
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(DRAWER_SETTLE_MS);
  check("Enter again closes it", where, !(await list.isVisible()));
  const marker = card.locator("a[data-fn-ref]").last();
  const target = (await marker.getAttribute("href"))!.slice(1);
  await marker.click();
  await settle(page);
  const landed = await page.evaluate((id) => {
    const item = document.getElementById(id)!;
    const box = item.getBoundingClientRect();
    return item.checkVisibility() && box.top >= 0 && box.bottom <= window.innerHeight;
  }, target);
  check("a marker opens the list at its footnote", where, landed);
  if (await list.isVisible()) await summary.click();
  await page.waitForTimeout(DRAWER_SETTLE_MS);
  if (js) await checkMarkerStaysPut(page, where, listBox!.height);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
}

// With a script, a marker on a card in view opens the list where the page is: no jump to the
// footnote and no new address. The page moves only when the list would end below the viewport, and
// then only until its bottom shows, never putting the list at the top. Focus goes to the footnote.
async function checkMarkerStaysPut(page: Page, where: string, listHeight: number) {
  for (const place of ["fits", "ends below"]) {
    const card = page.locator(SUPPLY_CARD);
    const summary = card.locator(".footnotes > summary");
    // The card's top just under what sticks over the page, which on a wide card leaves room for
    // the list, and its toggle near the bottom, which doesn't.
    await page.evaluate(
      ([selector, place]: [string, string]) => {
        const card = document.querySelector(selector)!;
        const sticky = [".site-header", ".dashboard .chain-filter"]
          .map((part) => document.querySelector(part))
          .filter((part) => part && ["sticky", "fixed"].includes(getComputedStyle(part).position))
          .map((part) => part!.getBoundingClientRect().bottom);
        const box = card.getBoundingClientRect();
        const summary = card.querySelector(".footnotes > summary")!.getBoundingClientRect();
        const by =
          place === "fits"
            ? box.top - Math.max(0, ...sticky) - 8
            : summary.top - (window.innerHeight - 60);
        window.scrollBy({ top: by, behavior: "instant" });
      },
      [`${SUPPLY} > [data-chain-panel="all"] > .chart-card`, place] as [string, string],
    );
    const before = await page.evaluate(() => ({
      y: window.scrollY,
      hash: location.hash,
    }));
    const { bottom: summaryBottom } = await summary.evaluate((element) =>
      element.getBoundingClientRect().toJSON(),
    );
    const fits = summaryBottom + listHeight + 16 <= HEIGHT;
    // The last marker in view and uncovered by the sticky header or filter, so the card is already
    // in view where it's clicked, and the click itself scrolls nothing.
    const index = await card.evaluate((element) => {
      const markers = [...element.querySelectorAll("a[data-fn-ref]")];
      let found = -1;
      markers.forEach((marker, at) => {
        const box = marker.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (box.bottom <= window.innerHeight && marker.contains(hit)) found = at;
      });
      return found;
    });
    if (index < 0) {
      check("a marker is in view to click", where, false, place);
      continue;
    }
    const marker = card.locator("a[data-fn-ref]").nth(index);
    const target = (await marker.getAttribute("href"))!.slice(1);
    await marker.click();
    await settle(page);
    const after = await page.evaluate((id) => {
      const list = document
        .getElementById(id)!
        .closest(".footnotes__list")!
        .getBoundingClientRect();
      const header = document.querySelector(".site-header")!.getBoundingClientRect().bottom;
      return {
        y: window.scrollY,
        hash: location.hash,
        listBottom: list.bottom,
        listTop: list.top,
        footnoteTop: document.getElementById(id)!.getBoundingClientRect().top,
        header,
        focused: document.activeElement?.id === id,
      };
    }, target);
    if (fits) {
      check(
        "a marker on a card in view leaves the page where it is when the list fits",
        where,
        Math.abs(after.y - before.y) <= 1,
        `${before.y} to ${after.y}`,
      );
    } else {
      check(
        "and when it doesn't fit, scrolls only until the list's bottom shows",
        where,
        after.y > before.y && after.footnoteTop > after.header + 1,
        `${before.y} to ${after.y}, footnote top ${Math.round(after.footnoteTop)}`,
      );
    }
    check(
      "the opened list ends inside the viewport",
      where,
      after.listBottom <= HEIGHT + 1,
      `${place}: ${Math.round(after.listBottom)}`,
    );
    check("a marker leaves the address as it was", where, after.hash === before.hash, place);
    check("and moves focus to its footnote", where, after.focused, place);
    await summary.click();
    await page.waitForTimeout(DRAWER_SETTLE_MS);
  }
}
