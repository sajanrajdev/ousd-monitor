import type { Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { WITHOUT_FRAME_EDGES } from "./constants.ts";
import { check, undeterminedContrast } from "./report.ts";

type Violations = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"];

function checkAxeResults(where: string, state: string, violations: Violations) {
  const serious = violations.filter((rule) =>
    ["serious", "critical"].includes(rule.impact as string),
  );
  check(
    `axe finds nothing serious with toggles ${state}`,
    where,
    serious.length === 0,
    serious.map((rule) => `${rule.id}: ${rule.nodes.length}`).join(", "),
  );
}

// Contrast needs what a normal pass skips: the graphic, hidden from assistive tech but read by eyes,
// and the text beside the frame's edges. So this drops both, and only judges contrast.
async function checkContrast(page: Page, where: string, state: string) {
  const style = await page.addStyleTag({ content: WITHOUT_FRAME_EDGES });
  await page.evaluate(() => {
    for (const area of document.querySelectorAll<HTMLElement>(".chart-area[aria-hidden]")) {
      area.removeAttribute("aria-hidden");
      area.dataset.wasHidden = "";
    }
  });
  const { violations, incomplete } = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    .analyze();
  await page.evaluate(() => {
    for (const area of document.querySelectorAll<HTMLElement>(".chart-area[data-was-hidden]")) {
      area.setAttribute("aria-hidden", "true");
      delete area.dataset.wasHidden;
    }
  });
  await style.evaluate((tag: Element) => tag.remove());
  const failing = violations.flatMap((rule) => rule.nodes);
  check(
    `contrast passes in the graphic and beside the frame, toggles ${state}`,
    where,
    failing.length === 0,
    failing
      .slice(0, 4)
      .map((node) => node.target.join(" "))
      .join(", "),
  );
  return incomplete.flatMap((rule) => rule.nodes).length;
}

export async function checkAxe(page: Page, where: string) {
  const undetermined: Record<string, number> = {};
  const openToggles = (open: boolean) =>
    page.evaluate((value: boolean) => {
      for (const toggle of document.querySelectorAll<HTMLDetailsElement>(".data-toggle"))
        toggle.open = value;
    }, open);
  // Axe skips what isn't drawn, so every tooltip opens for it, as one would for a reader.
  await page.evaluate(() => {
    for (const tip of document.querySelectorAll<HTMLElement>("[data-tip]")) {
      tip.dataset.open = "";
      tip.querySelector(":scope > [aria-expanded]")?.setAttribute("aria-expanded", "true");
    }
  });
  for (const [state, open] of [
    ["closed", false],
    ["open", true],
  ] as [string, boolean][]) {
    await openToggles(open);
    const { violations } = await new AxeBuilder({ page }).analyze();
    checkAxeResults(where, state, violations);
    undetermined[state] = await checkContrast(page, where, state);
  }
  await page.evaluate(() => {
    for (const tip of document.querySelectorAll<HTMLElement>("[data-tip]")) {
      delete tip.dataset.open;
      tip.querySelector(":scope > [aria-expanded]")?.setAttribute("aria-expanded", "false");
    }
  });
  undeterminedContrast.push(`${where}: ${undetermined.closed} closed, ${undetermined.open} open`);
}
