import type { Expected } from "./expected.ts";
import { everyRow } from "./names.ts";

// The page's serialized copy, which React takes over from once it loads, so what's in it is what a
// reader ends up seeing. Each line is an id and a JSON value, and an element is ["$", type, key, props].
// A parsed flight value: JSON of any shape, narrowed by the walkers below as they go.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
type Props = { [key: string]: Json | undefined; children?: Json };
type Values = Map<string, Json | undefined>;

function flightValues(flight: string) {
  const values: Values = new Map();
  for (const line of flight.split("\n")) {
    const match = /^([0-9a-f]+):(.+)$/.exec(line);
    if (!match) continue;
    try {
      values.set(match[1], JSON.parse(match[2]));
    } catch {
      // A module or hint row, which isn't JSON and holds no words.
    }
  }
  return values;
}

function flightProps(values: Values) {
  const found: Props[] = [];
  const walk = (node: Json | undefined) => {
    if (Array.isArray(node)) {
      if (node[0] === "$" && typeof node[1] === "string" && node[3]) found.push(node[3] as Props);
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  };
  values.forEach(walk);
  return found;
}

function flightText(node: Json | undefined, values: Values, seen = new Set<string>()): string {
  if (typeof node === "number") return String(node);
  if (typeof node === "string") {
    const reference = /^\$L?([0-9a-f]+)$/.exec(node);
    if (!reference) return node.replace(/^\$\$/, "$");
    if (seen.has(reference[1])) return "";
    seen.add(reference[1]);
    return flightText(values.get(reference[1]), values, seen);
  }
  if (!Array.isArray(node)) return "";
  if (node[0] === "$" && typeof node[1] === "string") {
    // A tooltip's panel is out of view, as in viewText. A note's words are read from inside it.
    const props = node[3] as Props | null | undefined;
    if (props?.className === "tip__panel") return "";
    return flightText(props?.children, values, seen);
  }
  return node.map((child) => flightText(child, values, seen)).join("");
}

const FLIGHT_PUSH = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;

export function inlineFlight(page: string, document: Document, problems: string[]) {
  let flight = "";
  for (const script of document.querySelectorAll("script")) {
    for (const match of script.textContent!.matchAll(FLIGHT_PUSH)) {
      try {
        flight += JSON.parse(match[1]);
      } catch {
        problems.push(`${page}: a chunk of the page's payload can't be read`);
      }
    }
  }
  return flight;
}

function flightCells(row: Props, values: Values) {
  const cells = Array.isArray(row.children) ? row.children : [row.children];
  return cells.map((cell) => flightText(cell, values).replace(/\s+/g, " ").trim());
}

// What a client component draws from: its rows' journey figures, as props.
function flightBandAmounts(values: Values) {
  const found = new Map<string, Json>();
  const walk = (node: Json | undefined) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      const { key, journey } = node as { key?: Json; journey?: { placed_exchange_linked?: Json } };
      if (typeof key === "string" && journey?.placed_exchange_linked !== undefined) {
        found.set(key, journey.placed_exchange_linked);
      }
      Object.values(node).forEach(walk);
    }
  };
  values.forEach(walk);
  return found;
}

// The same rows, caveats and band as the HTML, or the page changes under a reader once it loads. No
// elements to read is a failure, or a payload this check can't follow would turn the check off.
export function checkPayload(
  place: string,
  flight: string,
  expected: Expected,
  problems: string[],
) {
  const values = flightValues(flight);
  const props = flightProps(values);
  if (props.length === 0) {
    problems.push(`${place}: the page's payload can't be read`);
    return;
  }
  const words = (element: Props) =>
    flightText(element.children, values).replace(/\s+/g, " ").trim();
  const rows = props.filter((element) => element["data-exchange-row"]);
  const want = everyRow(expected);
  if (rows.length !== want.length) {
    problems.push(`${place}: the payload has ${rows.length} exchange rows`);
  }
  want.forEach(({ entity, detail, sourceHref, sourceText }, index) => {
    const row = rows[index];
    if (!row || words(row) !== `${entity}, ${detail}. Source: ${sourceText}.`) {
      problems.push(`${place}: the payload's row for "${entity}" isn't the dataset's`);
      return;
    }
    const inRow = flightProps(new Map([["row", row.children]]));
    if (inRow.find((element) => element["data-exchange-source"])?.href !== sourceHref) {
      problems.push(`${place}: the payload's row for "${entity}" hasn't the dataset's source`);
    }
  });
  for (const { kind, chain, text, exact } of expected.essentialNotes) {
    const shown = props
      .filter(
        (element) => element["data-note"] === kind && (!chain || element["data-chain"] === chain),
      )
      // A note's words are in its badge's tooltip, in the element that holds them.
      .map((element) => {
        const inNote = flightProps(new Map([["note", element.children]]));
        const held = inNote.find((child) => child["data-note-text"] !== undefined);
        return held ? words(held) : "";
      });
    if (!shown.some((said) => (exact ? said === text : said.includes(text)))) {
      problems.push(`${place}: the payload's ${kind} note isn't the dataset's`);
    }
  }
  const amounts = flightBandAmounts(values);
  const rowsOfCells = props
    .filter((element) => element.children !== undefined)
    .map((element) => flightCells(element, values));
  for (const { key, name, amount, exact } of expected.bands) {
    if (amounts.get(key) !== amount) {
      problems.push(
        `${place}: the payload's exchange-linked amount for ${key} isn't the dataset's`,
      );
    }
    if (key !== "all" && !rowsOfCells.some((cells) => cells[0] === name && cells.includes(exact))) {
      problems.push(`${place}: the payload's table has another exchange-linked amount for ${key}`);
    }
  }
}
