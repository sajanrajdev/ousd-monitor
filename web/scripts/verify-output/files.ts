import type { Expected } from "./expected.ts";
import { closeHtml, parseHtml } from "./dom.ts";
import { CSS_REQUEST, FRESH_SENTENCE, MIN_PIPELINE_STRING } from "./constants.ts";

export function checkEveryFile(
  path: string,
  content: string,
  expected: Expected,
  problems: string[],
) {
  const candidates = [content];
  if (path.endsWith(".html")) {
    const document = parseHtml(content);
    candidates.push(document.documentElement.textContent);
    closeHtml(document);
  }
  for (const text of candidates) {
    for (const secret of expected.pipelineStrings) {
      if (secret.length < MIN_PIPELINE_STRING) continue;
      const serialized = JSON.stringify(secret).slice(1, -1);
      if (text.includes(secret) || text.includes(serialized)) {
        problems.push(`${path}: holds a pipeline string that isn't reader copy`);
      }
    }
  }
  if (content.includes("_RPC_URL")) problems.push(`${path}: holds an RPC variable's name`);
  if (expected.frameWord && content.includes(FRESH_SENTENCE)) {
    problems.push(`${path}: holds "${FRESH_SENTENCE}" on non-real data`);
  } else if (expected.freshness === "stale" && content.includes(FRESH_SENTENCE)) {
    problems.push(`${path}: holds "${FRESH_SENTENCE}" on stale data`);
  }
  if (path.endsWith(".css") && CSS_REQUEST.test(content)) {
    problems.push(`${path}: a request to another host from CSS`);
  }
}
