import type { Browser } from "playwright";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Harness } from "./harness.ts";
import { serve } from "../local-browser.mjs";
import { AXE_WIDTHS } from "./constants.ts";
import { check, guarded, seen } from "./report.ts";
import { openPage } from "./session.ts";
import { checkFilter, checkStickyFilter } from "./filter.ts";
import {
  checkDashboardGrid,
  checkFocusRings,
  checkFold,
  checkHeadlineLines,
  checkInView,
  checkLegendsBeside,
  checkNoSidewaysScroll,
  checkTargets,
} from "./layout.ts";
import {
  checkClockSwap,
  checkMethodologyPage,
  checkReconciliation,
  checkReconciliationPage,
} from "./reconciliation.ts";
import { checkForcedColors, checkWithoutHas, checkWithoutJavaScript } from "./modes.ts";
import {
  checkEscapeStaysPut,
  checkFloating,
  checkHeadlineTooltip,
  checkHover,
  checkKpiTooltip,
  checkOneAtATime,
  checkTap,
} from "./tooltips.ts";
import { checkFootnotes, checkToggle } from "./toggle.ts";
import { checkAxe } from "./a11y.ts";
import {
  checkExchangeRowsOpen,
  checkStepLines,
  checkSupplyOptions,
  checkTableWords,
} from "./supply.ts";
import { checkActivityOptions, checkChainCards } from "./activity.ts";

export async function checkFolder(
  browser: Browser,
  folder: string,
  harness: Harness,
  widths: number[],
) {
  const partial = basename(folder) === "partial";
  const chains = partial ? ["tempo", "ethereum"] : ["tempo", "ethereum", "base", "solana"];
  const { markup } = harness;
  const server = await serve(folder);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const real = readFileSync(join(folder, "index.html"), "utf8").includes(
    'data-dataset-kind="real"',
  );
  if (real) {
    await guarded("the fold", basename(folder), () => checkFold(browser, origin, basename(folder)));
    seen.realFolders += 1;
  }
  for (const width of widths) {
    for (const js of [true, false]) {
      const where = `${basename(folder)} ${width} js ${js ? "on" : "off"}`;
      const options = { width, js };
      const { context, page, errors } = await openPage(browser, origin, folder, markup, options);
      const group = (name: string, run: () => Promise<unknown>) => guarded(name, where, run);
      await group("in view", () => checkInView(page, where));
      await group("focus", () => checkFocusRings(page, where));
      await group("the headline's lines", () =>
        checkHeadlineLines(page, where, width, harness.oneLineHeadline),
      );
      await group("the filter", () => checkFilter(page, where, js, chains));
      await group("the grid", () => checkDashboardGrid(page, where));
      await group("legends beside", () => checkLegendsBeside(page, where));
      await group("the sticky filter", () => checkStickyFilter(page, where, width));
      await group("the supply card", () => checkSupplyOptions(page, where));
      await group("the step lines", () => checkStepLines(page, where, js));
      await group("the activity cards", () => checkActivityOptions(page, where));
      await group("the chain cards", () => checkChainCards(page, where));
      await group("the exchange rows", () => checkExchangeRowsOpen(page, where));
      await group("the table's words", () => checkTableWords(page, where));
      await group("a KPI's tooltip", () => checkKpiTooltip(page, where));
      await group("the headline's tooltip", () => checkHeadlineTooltip(page, where));
      await group("reconciliation", () => checkReconciliation(page, where));
      await group("one at a time", () => checkOneAtATime(page, where, js));
      await group("floating", () => checkFloating(page, where, js));
      if (js) await group("hover", () => checkHover(page, where));
      if (js) await group("Escape", () => checkEscapeStaysPut(page, where));
      if (!js) await group("no script", () => checkWithoutJavaScript(page, where));
      await group("the toggle", () => checkToggle(page, where));
      await group("footnotes", () => checkFootnotes(page, where, js));
      await group("targets", () => checkTargets(page, where));
      await group("sideways scroll", () => checkNoSidewaysScroll(page, where));
      if (js && AXE_WIDTHS.has(width)) await group("axe", () => checkAxe(page, where));
      check("no console errors", where, errors.length === 0, errors.slice(0, 3).join(" | "));
      await context.close();
      if (js) {
        await guarded("the clock swap", where, () => checkClockSwap(browser, origin, where, width));
      }
      await guarded("tap", where, () => checkTap(browser, origin, folder, markup, where, options));
      await guarded("methodology", where, () => checkMethodologyPage(browser, origin, where, js));
      await guarded("the reconciliation page", where, () =>
        checkReconciliationPage(browser, origin, where, js),
      );
      await guarded("forced colours", where, () =>
        checkForcedColors(browser, origin, folder, markup, where, options),
      );
      await guarded("no :has()", where, () =>
        checkWithoutHas(browser, origin, folder, markup, chains, where, options),
      );
    }
  }
  server.close();
}
