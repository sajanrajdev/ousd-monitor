import type { Expected } from "./expected.ts";
import { UNKNOWN_TEXT } from "../../lib/format.ts";
import { viewText } from "./dom.ts";
import { checkBackLink } from "./every-page.ts";
import { TRUST_CAVEAT, definitionLink } from "./main-page.ts";

// The trust row's disclosure is its own page now, with a way back to the dashboard.
export function checkReconciliationPage(
  page: string,
  document: Document,
  expected: Expected,
  problems: string[],
) {
  const detail = document.querySelectorAll('main [data-section="reconciliation"]');
  if (detail.length !== 1) {
    problems.push(`${page}: there are ${detail.length} reconciliation details, not one`);
    return;
  }
  const text = viewText(detail[0]);
  if (!text.includes(TRUST_CAVEAT)) {
    problems.push(`${page}: the detail has lost what it says it doesn't verify`);
  }
  const line = detail[0].querySelector("[data-run-line]");
  if (!line?.textContent.includes(expected.runLine.stale)) {
    problems.push(`${page}: the detail doesn't state the reconciliation's state`);
  }
  if (detail[0].querySelectorAll("[data-check-list] > div").length !== expected.checkCount) {
    problems.push(`${page}: the detail doesn't list every check with its result`);
  }
  if (!definitionLink(detail[0])) problems.push(`${page}: the detail has no definition link`);
  if (!detail[0].querySelector("table") && !text.includes(UNKNOWN_TEXT)) {
    problems.push(`${page}: the detail has neither its table nor "${UNKNOWN_TEXT}"`);
  }
  checkBackLink(page, document, problems);
}
