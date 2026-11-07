import type { Page, Browser } from "playwright";
import {
  BOX_SLACK_PX,
  FOLDS,
  MIN_FILTER_TARGET,
  MIN_TARGET,
  NOTES_BESIDE_FROM,
  ONE_LINE_FROM,
} from "./constants.ts";
import { check } from "./report.ts";
import { boxOf } from "./session.ts";

// What must be in view with nothing opened. A stylesheet can hide what verify-output can't read.
export async function checkInView(page: Page, where: string) {
  const missing = await page.evaluate(() => {
    const startX = window.scrollX;
    const startY = window.scrollY;
    // Whether the element is what's at a point, once scrolled to. A clip, a cover or an off-screen
    // box leaves something else there, or nothing.
    const hits = (element: Element, rectOf: () => DOMRect) => {
      const before = rectOf();
      window.scrollBy({
        left: before.left + before.width / 2 - window.innerWidth / 2,
        top: before.top + before.height / 2 - window.innerHeight / 2,
        behavior: "instant",
      });
      const box = rectOf();
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return element.contains(at);
    };
    // The first and last lines of its text, so clipping part of a note counts as well.
    const textLines = (element: Element): (() => DOMRect)[] => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const ranges: Range[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement!;
        if (!(node as Text).data.trim() || parent.closest(".sr-only") || !parent.checkVisibility())
          continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (range.getClientRects().length > 0) ranges.push(range);
      }
      if (ranges.length === 0) return [];
      return [
        () => ranges[0].getClientRects()[0],
        () => [...ranges.at(-1)!.getClientRects()].at(-1)!,
      ];
    };
    const seen = (element: Element | null) => {
      if (!element?.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
      const box = element.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) return false;
      const { scrollWidth, scrollHeight } = document.documentElement;
      const onPage =
        box.right + window.scrollX > 0 &&
        box.left + window.scrollX < scrollWidth &&
        box.bottom + window.scrollY > 0 &&
        box.top + window.scrollY < scrollHeight;
      if (!onPage) return false;
      // The first fragment's centre: a wrapped inline box's own centre can fall outside its text.
      const spots = [() => element.getClientRects()[0], ...textLines(element)];
      return spots.every((rectOf) => hits(element, rectOf));
    };
    const lacking: string[] = [];
    const need = (name: string, element: Element | null) => {
      if (!seen(element)) lacking.push(name);
    };
    const root = document.documentElement;
    need("the footer's independence line", document.querySelector("footer .independence-line"));
    const status = document.querySelectorAll("footer [data-footer-status] a");
    if (![...status].some(seen)) lacking.push("the footer's reconciliation status");
    if (root.dataset.frame) need("the banner", document.querySelector("[data-dataset-banner]"));
    const verdict = document.querySelector('[data-section="verdict"]');
    if (verdict) {
      need("the headline", verdict.querySelector("h1"));
      const text = verdict.querySelector("[data-verdict-text]");
      if (text?.closest(".tip__panel")) {
        if (root.dataset.datasetKind !== "real") lacking.push("verdict.text, on non-real data");
      } else {
        need("verdict.text", text);
      }
      if (root.dataset.frame)
        need("the not-a-finding words", verdict.querySelector("[data-verdict-frame]"));
      const when = [...verdict.querySelectorAll(".freshness-text > *")];
      if (!when.some(seen)) lacking.push("the as-of line");
      // Only a build that didn't pass keeps the trust row at the top, and then it has to be seen.
      const strip = document.querySelector('[data-section="trust-strip"]');
      const trust = strip?.querySelectorAll(".freshness-text > *") ?? [];
      if (strip && ![...trust].some(seen)) lacking.push("the trust status");
      if (!strip && root.dataset.datasetKind !== "real")
        lacking.push("the trust row, off real data");
      for (const value of document.querySelectorAll("[data-kpi-value]")) need("a KPI value", value);
      for (const label of document.querySelectorAll('[data-section="kpi-row"] dt')) {
        need("a KPI label", label);
      }
      // The line under the KPI row is there only when it has something to add.
      const scope = document.querySelector('[data-section="kpi-row"] > p');
      if (scope) need("the KPI row's line", scope);
    }
    // Every caveat's footnote marker, wherever a unit pins it. A marker in a filter panel counts
    // while its panel shows. Its words are in the card's footnotes, which the footnote check opens.
    for (const marker of document.querySelectorAll<HTMLElement>("main a[data-fn-ref]")) {
      const panel = marker.closest("[data-chain-panel]");
      if (!panel || panel.checkVisibility()) need(`the ${marker.dataset.note} marker`, marker);
    }
    // An exchange's name and its source. A closed disclosure may hold them, and no stylesheet may hide them.
    for (const row of document.querySelectorAll("main [data-exchange-row]")) {
      const panel = row.closest("[data-chain-panel]");
      if (row.closest("details:not([open])") || (panel && !panel.checkVisibility())) continue;
      need("an exchange row", row);
      need("an exchange row's name", row.querySelector("[data-exchange-name]"));
      need("an exchange row's detail", row.querySelector("[data-exchange-detail]"));
      need("an exchange row's source", row.querySelector("[data-exchange-source]"));
    }
    // A legend's rows and the figures beside a bar, wherever their panel shows.
    for (const row of document.querySelectorAll(
      "main .chart-legend__row, main [data-stat], main [data-exchange-linked]",
    )) {
      const panel = row.closest("[data-chain-panel]");
      if (!panel || panel.checkVisibility()) need("a legend row or a figure beside its bar", row);
    }
    // Old real data says so in the footer, with its clock; anything else in a note at the top.
    const note = document.querySelector("[data-stale-note] .freshness-text > *");
    if (root.dataset.freshness === "stale") {
      if (root.dataset.datasetKind === "real") {
        need("the footer's clock state", document.querySelector("footer [data-stale-status]"));
      } else if (!verdict) {
        need("the stale note", note);
      }
    }
    for (const card of document.querySelectorAll(".chart-card")) {
      if (!card.checkVisibility()) continue;
      need("a card's heading", card.querySelector(".chart-card__head :is(h2, h3)"));
      need("a card's meta line", card.querySelector(".chart-card__meta"));
      need("a card's as-of time", card.querySelector(".chart-card__meta time"));
      if (root.dataset.frame) {
        need("a card's frame word", card.querySelector(".chart-card__frame-word"));
      }
      // Each footnote has its marker in the card, and the card its Footnotes toggle.
      const items = card.querySelectorAll(".footnotes__list > li");
      if (items.length > 0)
        need("a card's Footnotes toggle", card.querySelector(".footnotes > summary"));
      for (const item of items) {
        need("a footnote's marker", card.querySelector(`a[data-fn-ref][href="#${item.id}"]`));
      }
      if (card.querySelector(".tip__badge, .note-badges, .pin")) {
        lacking.push("one set of markers: a badge is back on a card");
      }
    }
    window.scrollTo({ left: startX, top: startY, behavior: "instant" });
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
export async function checkFocusRings(page: Page, where: string) {
  await page.keyboard.press("Shift");
  for (const selector of [
    ".tip__icon",
    ".footnotes > summary",
    "a[data-fn-ref]",
    ".data-toggle > summary",
    ".chain-filter input:checked",
    "header a",
    "footer [data-footer-status] a:visible",
  ]) {
    const target = page.locator(selector).first();
    await target.focus();
    const shows = await target.evaluate((element: Element) => {
      const ringed = element.matches(".chain-filter input") ? element.nextElementSibling! : element;
      const { outlineStyle, outlineWidth } = getComputedStyle(ringed);
      return outlineStyle !== "none" && parseFloat(outlineWidth) > 0;
    });
    check("focus shows an outline", where, shows, selector);
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

export async function checkTargets(page: Page, where: string) {
  const small = await page.evaluate(
    ([minimum, filterMinimum]) => {
      const boxes = (selector: string) =>
        [...document.querySelectorAll(selector)]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => element.getBoundingClientRect());
      return [
        ...boxes(
          ".tip__icon, .footnotes > summary, .data-toggle > summary, .trust-strip a, footer [data-footer-status] a, footer nav a, header nav a",
        ).filter((box) => box.width < minimum || box.height < minimum),
        ...boxes(".chain-filter label").filter((box) => box.height < filterMinimum),
      ].length;
    },
    [MIN_TARGET, MIN_FILTER_TARGET],
  );
  check("targets are at least 24 px, and the filter's 36", where, small === 0, `${small} under`);
}

export async function checkNoSidewaysScroll(page: Page, where: string) {
  const values = await page
    .locator(".chain-filter input")
    .evaluateAll((inputs: HTMLInputElement[]) => inputs.map((input) => input.value));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll<HTMLDetailsElement>("main details")) {
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
      const PARTS = ".hairline-table, .data-toggle__panel, .footnotes__list, .chart-area";
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

export async function checkHeadlineLines(
  page: Page,
  where: string,
  width: number,
  oneLine: string,
) {
  if (width < ONE_LINE_FROM) return;
  const { text, lines } = await page.evaluate(() => {
    const heading = document.querySelector("h1")!;
    const { lineHeight } = getComputedStyle(heading);
    return {
      text: heading.textContent,
      lines: Math.round(heading.getBoundingClientRect().height / parseFloat(lineHeight)),
    };
  });
  if (text === oneLine) check("the usual headline fits one line from 1056", where, lines === 1);
}

// Only what the plan's fold says, on real data. Anything else is a build the fold doesn't speak for.
export async function checkFold(browser: Browser, origin: string, where: string) {
  for (const { viewport, above, starts } of FOLDS) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const at = `${where} ${viewport.width}x${viewport.height}`;
    for (const name of above) {
      const box = await boxOf(page, `[data-section="${name}"]`);
      check(
        "above the fold on real data",
        at,
        box !== null && box.bottom <= viewport.height,
        `${name}: ${box ? Math.round(box.bottom) : "gone"}`,
      );
    }
    if (starts) {
      const box = await boxOf(page, `[data-section="${starts}"]`);
      check(
        "the next part starts above the fold",
        at,
        box !== null && box.top < viewport.height,
        `${starts}: ${box ? Math.round(box.top) : "gone"}`,
      );
    }
    await context.close();
  }
}

// One card to a row at every width, each as wide as the content, with the filter above them all.
export async function checkDashboardGrid(page: Page, where: string) {
  // From the top, as the filter sticks once the page scrolls past it.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const filter = await boxOf(page, ".dashboard .chain-filter");
  const main = await page.evaluate(() => {
    const element = document.querySelector("main")!;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      left: box.left + parseFloat(style.paddingLeft),
      right: box.right - parseFloat(style.paddingRight),
    };
  });
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll(".dashboard .chart-card")]
      .filter((card) => card.checkVisibility())
      .map((card) => {
        const box = card.getBoundingClientRect();
        return {
          id: card.closest("[id]")?.id,
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          right: box.right,
        };
      }),
  );
  check("the page has its six cards", where, cards.length === 6, `${cards.length}`);
  check(
    "the filter sits above the cards",
    where,
    filter !== null && cards.every((card) => filter.bottom <= card.top + BOX_SLACK_PX),
  );
  const narrow = cards.filter(
    (card) => Math.abs(card.left - main.left) > 1 || Math.abs(card.right - main.right) > 1,
  );
  check(
    "every card spans the content width",
    where,
    narrow.length === 0,
    narrow.map(({ id }) => id).join(),
  );
  const shared = cards.filter((card, index) => index > 0 && card.top < cards[index - 1].bottom);
  check("one card to a row", where, shared.length === 0, shared.map(({ id }) => id).join());
}

// A card with room has its legend beside its chart. Measured on every filtered card, as the rule is
// what the maintainer asked for, and a narrower card keeps the legend directly under the chart.
export async function checkLegendsBeside(page: Page, where: string) {
  const found = await page.evaluate(
    ([slack, minimum]) => {
      const out = [];
      for (const card of document.querySelectorAll(".dashboard .chart-card")) {
        if (!card.checkVisibility()) continue;
        const chart = card.querySelector(".chart-area")?.getBoundingClientRect();
        const legend = card.querySelector(".chart-legend")?.getBoundingClientRect();
        if (!chart || !legend) continue;
        const wide = card.getBoundingClientRect().width >= minimum;
        const overlap = Math.min(chart.bottom, legend.bottom) - Math.max(chart.top, legend.top);
        const beside = legend.left >= chart.right - slack && overlap > 0;
        const below = legend.top >= chart.bottom - slack;
        out.push({ wide, beside, below });
      }
      return out;
    },
    [BOX_SLACK_PX, NOTES_BESIDE_FROM],
  );
  // The supply cards have a legend beside their chart. The activity cards have none.
  check("the page has legends to check", where, found.length === 2);
  for (const { wide, beside, below } of found) {
    if (wide) check("a legend sits beside its chart from 560", where, beside);
    else check("a narrower card has its legend under the chart", where, below);
  }
}
