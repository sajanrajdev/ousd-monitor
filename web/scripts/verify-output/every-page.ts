import type { Expected } from "./expected.ts";
import { HAS_SCHEME, INDEPENDENCE_LINE, REQUEST_ATTRIBUTES } from "./constants.ts";
import { inView, viewText, visibleMeta } from "./dom.ts";

// The header keeps only the name, so the independence line is the footer's, in view with nothing
// opened, on every page.
export function checkEveryPage(page: string, document: Document, problems: string[]) {
  const footer = viewText(document.querySelector("footer"));
  if (!footer.includes(INDEPENDENCE_LINE)) {
    problems.push(`${page}: no independence line in the footer`);
  }
  if (!/not financial advice/i.test(footer)) problems.push(`${page}: no "not financial advice"`);
  if (!document.querySelector('footer a[href^="/methodology"]')) {
    problems.push(`${page}: no methodology link in the footer`);
  }
  if (!document.querySelector('header a[href^="/methodology"]')) {
    problems.push(`${page}: no methodology link in the header`);
  }
  if (!document.querySelector('header a[href="/"]')) {
    problems.push(`${page}: the site's name in the header doesn't link to /`);
  }
  // Every page but the dashboard has a clear way back to it, above its title.
  if (page !== "index.html" && !/^(404|_not-found)/.test(page))
    checkBackLink(page, document, problems);
}

// An arrow named "Back to the dashboard" for assistive tech, before the page's title.
export function checkBackLink(page: string, document: Document, problems: string[]) {
  const back = [...document.querySelectorAll('main a[href="/"]')].find(
    (link) =>
      (link.getAttribute("aria-label") ?? viewText(link)).trim() === "Back to the dashboard" &&
      inView(link),
  );
  const title = document.querySelector("main h1");
  if (!back) {
    problems.push(`${page}: no "Back to the dashboard" link to /`);
  } else if (
    !title ||
    !(
      back.compareDocumentPosition(title) &
      back.ownerDocument.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING
    )
  ) {
    problems.push(`${page}: the way back isn't above the page's title`);
  }
}

const RECONCILED = /\bReconciled\b/;

// The tooltip a footer status link describes.
function footerTip(document: Document, element: Element | null) {
  const link = element?.querySelector('a[href="/reconciliation/"]');
  return link && document.getElementById(link.getAttribute("aria-describedby") ?? "");
}

// "Reconciled", in green with a tick, is for a build that passed. On any other it's nowhere in the
// footer, seen or swapped out, so a reader's clock can't reveal it either. Real data that's old, or
// that a reader's clock finds old, has an amber clock and "Last reconciled" with the day, and the
// dated sentence as its tooltip. Each links to the detail page.
export function checkFooterStatus(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  const status = document.querySelector("footer [data-footer-status]");
  if (!status) {
    problems.push(`${page}: no reconciliation status in the footer`);
    return;
  }
  const marked = status.querySelectorAll("[data-reconciled]");
  // The words in the footer itself, each apart, with the tooltips left out.
  const own = status.cloneNode(true);
  for (const panel of (own as Element).querySelectorAll(".tip__panel")) panel.remove();
  const words = [...(own as Element).querySelectorAll("*")]
    .map((element) => element.textContent)
    .join(" ");
  if (!expected.passing && (marked.length > 0 || RECONCILED.test(words))) {
    problems.push(`${page}: the footer says "Reconciled" on a build that didn't pass`);
  }
  if (expected.kind !== "real") {
    if (!viewText(status).includes(expected.trustLine.stale)) {
      problems.push(`${page}: the footer's status doesn't say "${expected.trustLine.stale}"`);
    }
  } else {
    const stale = status.querySelectorAll("[data-stale-status]");
    const clock = stale[0];
    if (stale.length !== 1 || !clock.closest(".freshness-text__stale")) {
      problems.push(`${page}: the footer has no clock state to show once the data is old`);
    } else {
      if (
        clock.querySelector(".tip__trigger")?.textContent.trim() !== expected.trustLine.short ||
        RECONCILED.test(clock.textContent) ||
        !clock.querySelector("svg circle")
      ) {
        problems.push(
          `${page}: the footer's clock state isn't a clock and "${expected.trustLine.short}"`,
        );
      }
      if (!footerTip(document, clock)?.textContent.includes(expected.trustLine.stale)) {
        problems.push(`${page}: the footer's clock state has no tooltip with the dated sentence`);
      }
      if (!expected.passing && !inView(clock)) {
        problems.push(`${page}: the footer's clock state isn't in view on old data`);
      }
    }
  }
  if (expected.passing) {
    const word = marked[0];
    if (marked.length !== 1 || !word.closest(".freshness-text__fresh")) {
      problems.push(`${page}: the footer's "Reconciled" isn't its fresh text, once`);
    } else if (viewText(word).trim() !== "Reconciled" || !word.querySelector("svg path")) {
      problems.push(`${page}: the footer's "Reconciled" lost its tick or its word`);
    }
    if (!footerTip(document, word)?.textContent!.includes(expected.trustLine.fresh!)) {
      problems.push(`${page}: the footer's "Reconciled" has no tooltip with the dated sentence`);
    }
  }
  if (!status.querySelector('a[href="/reconciliation/"]')) {
    problems.push(`${page}: the footer's status doesn't link to the reconciliation page`);
  }
}

export function checkStateOnPage(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  const root = document.documentElement;
  if (root.dataset.datasetKind !== expected.kind) {
    problems.push(
      `${page}: page root says ${root.dataset.datasetKind}, dataset is ${expected.kind}`,
    );
  }
  if (root.dataset.datasetVersion !== expected.version) {
    problems.push(`${page}: built from another dataset version`);
  }
  const word = expected.frameWord;
  const banner = document.querySelector("[data-dataset-banner]");
  if (!word) {
    if (banner || root.dataset.frame) problems.push(`${page}: real data has the non-real frame`);
    return;
  }
  if (root.dataset.frame !== word) problems.push(`${page}: no ${word} frame on the page root`);
  if (!viewText(banner).trim()) problems.push(`${page}: no ${word} banner`);
  if (!document.title.startsWith(`[${word}]`)) problems.push(`${page}: no [${word}] in the title`);
  const robots = document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "";
  if (!robots.includes("noindex")) problems.push(`${page}: no noindex`);
  for (const card of document.querySelectorAll(".chart-card")) {
    if (card.getAttribute("data-frame") !== word) {
      problems.push(`${page}: a card has no ${word} edge`);
    }
    if (!viewText(visibleMeta(card) ?? null).includes(word)) {
      problems.push(`${page}: a card has no "${word}" beside its as-of time`);
    }
  }
}

// Every page says when its data is out of date. On sample or preview data, or after a failed run, a
// note at the top does, there while fresh too, for the clock. On real data that's only old, the
// footer's clock state does, and nothing sits between the header and the page.
export function checkFreshnessOnPage(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  const shown = document.documentElement.dataset.freshness;
  if (shown !== "fresh" && shown !== "stale") {
    problems.push(`${page}: no freshness on the page root`);
  } else if (expected.freshness === "stale" && shown !== "stale") {
    problems.push(`${page}: page root says fresh, dataset is stale`);
  }
  const found = document.querySelector("[data-stale-note]");
  if (expected.staleInFooter) {
    if (found) problems.push(`${page}: a stale note is at the top of real data`);
    return;
  }
  if (!viewText(found).includes(expected.asOfLine.stale)) problems.push(`${page}: no stale note`);
}

const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

// Every tooltip is reached by keyboard: its trigger is a native button or link, with a name, and
// points at its panel, which comes straight after it, so Tab moves from one into the other. A panel
// with anything focusable is a disclosure, with aria-expanded, as role="tooltip" can't hold a link.
export function checkTooltips(page: string, document: Document, problems: string[]) {
  for (const tip of document.querySelectorAll("[data-tip]")) {
    const trigger = tip.querySelector(":scope > .tip__trigger");
    const panel = tip.querySelector(":scope > .tip__panel");
    const name = trigger?.getAttribute("aria-label")?.trim() || trigger?.textContent.trim();
    const native =
      trigger?.tagName === "BUTTON" || (trigger?.tagName === "A" && trigger.hasAttribute("href"));
    if (!trigger || !native || trigger.getAttribute("tabindex") === "-1" || !name) {
      problems.push(`${page}: a tooltip's trigger can't be reached by keyboard, or has no name`);
      continue;
    }
    if (!panel?.id || trigger.nextElementSibling !== panel) {
      problems.push(`${page}: a tooltip's panel doesn't follow its trigger`);
      continue;
    }
    const interactive = panel.querySelector(FOCUSABLE) !== null;
    if (interactive) {
      if (
        trigger.getAttribute("aria-controls") !== panel.id ||
        !trigger.hasAttribute("aria-expanded") ||
        panel.getAttribute("role") === "tooltip"
      ) {
        problems.push(`${page}: a tooltip with a link isn't a disclosure`);
      }
    } else if (
      trigger.getAttribute("aria-describedby") !== panel.id &&
      trigger.getAttribute("aria-controls") !== panel.id
    ) {
      problems.push(`${page}: a tooltip's trigger doesn't point at its panel`);
    } else if (
      trigger.getAttribute("aria-describedby") === panel.id &&
      panel.getAttribute("role") !== "tooltip"
    ) {
      problems.push(`${page}: a tooltip describing its trigger has no role="tooltip"`);
    }
  }
}

export const DEFINITION_LINK = /^\/methodology\/?#[\w-]+$/;

function hasSourceAndDefinition(block: Element | null) {
  return {
    source: [...(block?.querySelectorAll("p") ?? [])].some((line) =>
      /Source:\s*[^\s·]/.test(line.textContent),
    ),
    definition: [...(block?.querySelectorAll("a[href]") ?? [])].some((link) =>
      DEFINITION_LINK.test(link.getAttribute("href")!),
    ),
  };
}

// A chart with nothing in the static HTML is blank with JavaScript off, so it has to say so.
function drawsOnlyInBrowser(area: Element) {
  return !area.textContent!.trim() || area.querySelector(".recharts-responsive-container");
}

// A card's takeaway and time stay in view. Its source and definition are one tap away in the
// tooltip, and are in a plain note with JavaScript off, which the page's parser reads as elements
// here. The table is required by type, and this says it reached the page.
export function checkCards(page: string, document: Document, problems: string[]) {
  for (const card of document.querySelectorAll(".chart-card")) {
    const headings = [...card.querySelectorAll(".chart-card__head h2, .chart-card__head h3")];
    if (!headings.some((heading) => viewText(heading).trim())) {
      problems.push(`${page}: a card has no visible takeaway`);
    }
    const time = visibleMeta(card)?.querySelector("time[datetime]");
    if (!time?.getAttribute("datetime")!.trim() || !viewText(time).trim()) {
      problems.push(`${page}: a card has no visible as-of time`);
    }
    const panel = hasSourceAndDefinition(
      card.querySelector(".chart-card__head > .tip--info > .tip__panel"),
    );
    if (!panel.source) problems.push(`${page}: a card's tooltip has no source`);
    if (!panel.definition) problems.push(`${page}: a card's tooltip has no definition link`);
    const notes = [...card.querySelectorAll("noscript")].map(hasSourceAndDefinition);
    if (!notes.some((note) => note.source)) {
      problems.push(`${page}: a card's noscript note has no source`);
    }
    if (!notes.some((note) => note.definition)) {
      problems.push(`${page}: a card's noscript note has no definition link`);
    }
    if (!card.querySelector("table")) problems.push(`${page}: a card has no table`);
    for (const area of card.querySelectorAll(".chart-area")) {
      const note = area.parentElement!.querySelector("noscript .chart-area__needs-js");
      if (drawsOnlyInBrowser(area) && !note) {
        problems.push(`${page}: a chart that draws only in the browser has no note for it`);
      }
    }
  }
  for (const notes of document.querySelectorAll("[data-footnotes]")) {
    if (notes.closest("noscript, .tip__panel") || notes.parentElement!.closest("details")) {
      problems.push(`${page}: footnotes inside a details, noscript or tooltip`);
    }
    if (notes.hasAttribute("open"))
      problems.push(`${page}: a card's footnotes are open by default`);
  }
}

export function checkLinksAndRequests(page: string, document: Document, problems: string[]) {
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name)) problems.push(`${page}: an ${attribute.name} attribute`);
    }
  }
  for (const link of document.querySelectorAll("a[href], area[href]")) {
    const href = link.getAttribute("href")!.trim();
    if (href.startsWith("https://")) {
      const rel = (link.getAttribute("rel") ?? "").split(/\s+/);
      if (!rel.includes("noopener") || !rel.includes("noreferrer")) {
        problems.push(`${page}: an outbound link without rel="noopener noreferrer"`);
      }
    } else if (!href.startsWith("mailto:") && (HAS_SCHEME.test(href) || href.startsWith("//"))) {
      problems.push(`${page}: a link that isn't https, mailto or same-site`);
    }
  }
  for (const [tag, attribute] of REQUEST_ATTRIBUTES) {
    for (const element of document.querySelectorAll(`${tag}[${attribute}]`)) {
      const value = element.getAttribute(attribute)!.trim();
      if (HAS_SCHEME.test(value) || value.startsWith("//")) {
        problems.push(`${page}: a request to another host from <${tag}>`);
      }
    }
  }
}
