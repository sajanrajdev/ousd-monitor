import type { ChainName } from "../../lib/dataset/index.ts";
import type { Expected } from "./expected.ts";

type SupplyPanel = Expected["supplyPanels"][number];
// A note as the checks hold it: its words, and where its marker sits, if the card says.
type PanelNote = { kind: string; chain?: ChainName; at?: string; words: string; tip?: string };
import { UNKNOWN_TEXT } from "../../lib/format.ts";
import { inView, plainText, viewText } from "./dom.ts";
import { footnoteList } from "./main-page.ts";

export const panelOf = (box: Element | null, value: string) =>
  box?.querySelector(`:scope > [data-chain-panel="${value}"]`);

// One panel per filter option and no other, each with a card of its own.
export function panelsOf(
  page: string,
  document: Document,
  id: string,
  expected: Expected,
  problems: string[],
) {
  const box = document.getElementById(id);
  const values = [...(box?.querySelectorAll(":scope > [data-chain-panel]") ?? [])].map(
    (panel) => (panel as HTMLElement).dataset.chainPanel,
  );
  const want = expected.filter.map(({ value }) => value);
  if (values.join() !== want.join()) {
    problems.push(`${page}: #${id} has panels for ${values.join()}, not ${want.join()}`);
  }
  return box;
}

export function checkTableRows(
  where: string,
  table: Element | null,
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[],
  problems: string[],
) {
  const shown = [...(table?.querySelectorAll("tbody tr") ?? [])];
  if (shown.length !== rows.length) {
    problems.push(`${where}: its table has ${shown.length} rows, not ${rows.length}`);
    return;
  }
  rows.forEach((row, index) => {
    for (const { key, label } of columns) {
      const cell = ([...shown[index].children] as HTMLElement[]).find(
        (td) => td.dataset.label === label,
      );
      if (plainText(cell) !== String(row[key])) {
        problems.push(`${where}: its table's ${label} isn't the dataset's`);
      }
    }
  });
}

// Notes about the whole card come first, on its title, then the rest in their own order, as the
// card numbers them.
const ordered = (notes: PanelNote[]) => [
  ...notes.filter((note) => !note.at),
  ...notes.filter((note) => note.at),
];

// The notes this panel holds, in order, each whole, and none for another chain, as its footnotes. A
// footnote's number is its note's place in that order, and its markers run in reading order. A note
// about the whole card has its marker on the title, and any other on the legend row, waterfall row
// or chain it qualifies. One footnote list, and one set of markers.
export function checkPanelNotes(
  where: string,
  panel: Element,
  notes: PanelNote[],
  problems: string[],
) {
  const want = ordered(notes);
  const cards = panel.matches(".chart-card") ? [panel] : [...panel.querySelectorAll(".chart-card")];
  const list = cards.length === 1 ? footnoteList(cards[0]) : null;
  if (want.length === 0) {
    if (panel.querySelector("[data-footnotes], a[data-fn-ref]")) {
      problems.push(`${where}: it has footnotes but no notes`);
    }
    return;
  }
  if (!list) {
    problems.push(`${where}: it has no footnotes toggle with its list`);
    return;
  }
  const items = [...list.children] as HTMLElement[];
  const said = items.map((item) => `${item.dataset.note}:${item.dataset.chain ?? ""}`);
  const wanted = want.map(({ kind, chain }) => `${kind}:${chain ?? ""}`);
  if (said.join() !== wanted.join()) {
    problems.push(`${where}: its footnotes are ${said.join()}, not ${wanted.join()}`);
    return;
  }
  const markers = [...panel.querySelectorAll<HTMLElement>("a[data-fn-ref]")];
  const numbers = markers.map((marker) => Number(plainText(marker)));
  if (numbers.some((number, index) => index > 0 && number <= numbers[index - 1])) {
    problems.push(`${where}: its footnote markers aren't in reading order: ${numbers.join()}`);
  }
  want.forEach(({ kind, chain, words, tip, at }, index) => {
    const item = items[index];
    if (plainText(item.querySelector("[data-note-text]")).replace(/\s+/g, " ") !== words) {
      problems.push(`${where}: its ${kind} footnote doesn't keep its words`);
    }
    const full = item.querySelector("[data-note-full]");
    if (tip && !full?.textContent.replace(/\s+/g, " ").includes(tip)) {
      problems.push(`${where}: its ${kind} footnote has lost its words in full`);
    }
    const own = markers.filter((marker) => marker.getAttribute("href") === `#${item.id}`);
    if (own.length !== 1 || plainText(own[0]) !== String(index + 1) || !item.id) {
      problems.push(`${where}: its ${kind} footnote hasn't one marker numbered ${index + 1}`);
      return;
    }
    if (own[0].dataset.note !== kind || (own[0].dataset.chain ?? "") !== (chain ?? "")) {
      problems.push(`${where}: its ${kind} marker links to another note's footnote`);
    }
    if (!inView(own[0])) problems.push(`${where}: its ${kind} marker isn't in view`);
    const place = at
      ? own[0].closest(`[data-segment="${at}"], [data-step="${at}"], [data-velocity-chain="${at}"]`)
      : own[0].closest(".chart-card__head");
    if (!place || !panel.contains(place)) {
      problems.push(`${where}: its ${kind} marker isn't on ${at ?? "the card's title"}`);
    }
  });
  if (markers.length !== want.length) {
    problems.push(`${where}: it has ${markers.length} footnote markers for ${want.length} notes`);
  }
}

export function checkPanelBar(
  where: string,
  panel: Element,
  { key, total, parts }: Pick<SupplyPanel, "key" | "total" | "parts">,
  problems: string[],
) {
  const bar = panel.querySelector<HTMLElement>("[data-supply-bar]");
  if (!parts.some(({ amount }) => BigInt(amount) > 0n)) {
    if (bar) problems.push(`${where}: it draws a bar with no supply`);
    if (!viewText(panel).includes(UNKNOWN_TEXT)) {
      problems.push(`${where}: it doesn't say "${UNKNOWN_TEXT}"`);
    }
    return;
  }
  if (bar?.dataset.supplyBar !== key || !inView(bar!)) {
    problems.push(`${where}: its bar isn't ${key}'s, in view`);
    return;
  }
  const drawn = [...bar!.querySelectorAll<HTMLElement>("[data-part]")];
  const sum = drawn.reduce((held, part) => held + BigInt(part.dataset.amount ?? 0), 0n);
  if (sum.toString() !== total) {
    problems.push(`${where}: its bar's parts add up to ${sum}, not its total of ${total}`);
  }
  for (const { key: part, amount, width, band, direct } of parts) {
    const shown = drawn.find((element) => element.dataset.part === part);
    if (BigInt(amount) === 0n) {
      if (shown) problems.push(`${where}: its bar draws ${part} at zero`);
      continue;
    }
    if (shown?.dataset.amount !== amount) {
      problems.push(`${where}: its bar's ${part} isn't the dataset's`);
      continue;
    }
    if (!(shown.getAttribute("style") ?? "").replace(/\s+/g, "").includes(`flex-basis:${width}`)) {
      problems.push(`${where}: its bar's ${part} isn't drawn at its share`);
    }
    if (plainText(shown.querySelector("[data-direct-label]")) !== (direct ?? "")) {
      problems.push(`${where}: its bar's ${part} doesn't carry the dataset's label`);
    }
    const marked = shown.querySelector('[data-testid="exchange-linked-band"]');
    if (Boolean(marked) !== (band !== null && BigInt(band) > 0n)) {
      problems.push(`${where}: its ${part} band doesn't match the dataset`);
    }
  }
}

// Every segment on every panel, with what the dataset gives, so the legend can't jump or disagree.
export function checkPanelLegend(
  where: string,
  panel: Element,
  { parts }: Pick<SupplyPanel, "parts">,
  problems: string[],
) {
  const rows = [...panel.querySelectorAll<HTMLElement>("[data-supply-legend] [data-segment]")];
  const keys = parts.map(({ key }) => key);
  if (rows.map((row) => row.dataset.segment).join() !== keys.join()) {
    problems.push(`${where}: its legend doesn't list every segment`);
    return;
  }
  parts.forEach(({ key, label, compact, share, floor, bandLine }, index) => {
    const row = rows[index];
    const text = (selector: string) => plainText(row.querySelector(selector));
    if (!viewText(row).trim()) problems.push(`${where}: its ${key} legend row isn't in view`);
    if (text("[data-segment-label]") !== label) {
      problems.push(`${where}: its ${key} legend row doesn't say "${label}"`);
    }
    if (text("[data-segment-amount]") !== `${floor ? "≥" : ""}${compact}`) {
      problems.push(`${where}: its ${key} legend amount isn't the dataset's`);
    }
    if (text("[data-segment-share]") !== share) {
      problems.push(`${where}: its ${key} legend share isn't the dataset's`);
    }
    if (Boolean(row.querySelector('[data-coverage="floor"]')) !== floor) {
      problems.push(`${where}: its ${key} legend row has the wrong coverage mark`);
    }
    if (bandLine !== null) {
      const line = panel.querySelector(`[data-band="${key}"]`);
      if (plainText(line) !== bandLine || !viewText(line).trim()) {
        problems.push(`${where}: its ${key} band line isn't the dataset's`);
      }
    }
  });
}

export function checkPanelStats(
  where: string,
  panel: Element,
  stats: SupplyPanel["stats"],
  problems: string[],
) {
  const shown = [...panel.querySelectorAll<HTMLElement>("[data-stat]")];
  const said = shown.map((stat) => stat.dataset.stat);
  const want = stats.map(({ key }) => key);
  // Wallets are never summed, so All shows none: this is what holds a total off the page.
  if (said.join() !== want.join()) {
    problems.push(`${where}: it shows ${said.join()} beside the bar, not ${want.join()}`);
    return;
  }
  stats.forEach(({ key, value }, index) => {
    if (viewText(shown[index].querySelector("[data-stat-value]")).trim() !== value) {
      problems.push(`${where}: its ${key} isn't the dataset's`);
    }
  });
}

// Each filter option's supply card holds what the dataset gives that chain, in view. The checks above
// read the whole page, so a panel with a wrong figure or a lost caveat would pass them.
export const WALLET_TABLE_COLUMNS = [
  { key: "chain", label: "Chain" },
  { key: "clean", label: "Clean volume, 7 days" },
  { key: "wallets", label: "Active wallets, 7 days" },
];

// Held to the KPI rows, which the page's own supply code doesn't read, so a fault in that code can't
// set what this check expects. Wallets are never summed, so a panel over several chains shows no
// wallet figure outside its tooltip, footnotes and table, whatever the stats list says.
export function checkPanelAgainstKpis(
  where: string,
  panel: Element,
  want: Pick<SupplyPanel, "chains" | "fromKpis">,
  problems: string[],
) {
  const shown = panel.cloneNode(true) as Element;
  for (const hidden of shown.querySelectorAll(
    ".data-toggle, .footnotes, .tip__panel, .sr-only, noscript",
  )) {
    hidden.remove();
  }
  if (want.chains > 1 && /active wallets/i.test(shown.textContent!)) {
    problems.push(`${where}: it shows a wallet figure across chains`);
  }
  const stat = (key: string) =>
    viewText(panel.querySelector(`[data-stat="${key}"] [data-stat-value]`)).trim();
  for (const [key, value] of Object.entries(want.fromKpis)) {
    if (stat(key) !== value) problems.push(`${where}: its ${key} disagrees with the KPI rows`);
  }
}

// Held to the dataset's own rows, which the page's supply code doesn't read, so a fault in that code
// can't set what this check expects: a chain's panel showing every chain's figures is caught here.
export function checkPanelAgainstRows(
  where: string,
  panel: Element,
  { scope, legend, band, table }: SupplyPanel["fromRows"],
  problems: string[],
) {
  for (const [key, value] of Object.entries(legend)) {
    const row = panel.querySelector(`[data-supply-legend] [data-segment="${key}"]`);
    if (plainText(row?.querySelector("[data-segment-amount]")).replace("≥", "") !== value) {
      problems.push(`${where}: its ${key} legend amount isn't ${scope}'s in the dataset`);
    }
  }
  const line = panel.querySelector('[data-supply-legend] [data-band="placed_supply"]');
  if (band !== null && !plainText(line).includes(` ${band} `)) {
    problems.push(`${where}: its exchange-linked line isn't ${scope}'s in the dataset`);
  }
  const shown = [
    ...(panel.querySelector(".data-toggle table")?.querySelectorAll("tbody tr") ?? []),
  ];
  const names = shown.map((tr) => plainText(tr.querySelector('[data-label="Chain"]')));
  if (names.join() !== table.map(({ chain }) => chain).join()) {
    problems.push(`${where}: its table's chains aren't ${scope}'s, as ${names.join()}`);
    return;
  }
  table.forEach(({ chain, cells }, index) => {
    for (const [label, value] of Object.entries(cells)) {
      const cell = shown[index].querySelector(`[data-label="${label}"]`);
      if (plainText(cell) !== value) {
        problems.push(`${where}: its table's ${label} for ${chain} isn't the dataset's`);
      }
    }
  });
}

// The names under a panel's table are its own: every one across chains on All, a chain's holdings on
// a chain, which says what it leaves out rather than showing All's.
export function checkPanelExchanges(
  where: string,
  panel: Element,
  { rows, unsplit }: SupplyPanel["exchanges"],
  problems: string[],
) {
  const named = [...panel.querySelectorAll(".data-toggle [data-labels-table] [data-exchange-row]")];
  const said = named.map(
    (row) =>
      `${plainText(row.querySelector("[data-exchange-name]"))}: ${plainText(row.querySelector("[data-exchange-detail]"))}`,
  );
  const want = rows.map(({ entity, detail }) => `${entity}: ${detail}`);
  if (said.join("; ") !== want.join("; ")) {
    problems.push(`${where}: its named exchanges aren't the dataset's for it`);
  }
  const note = panel.querySelector(".data-toggle [data-exchanges-unsplit]");
  if ((unsplit ?? "") !== plainText(note)) {
    problems.push(`${where}: it doesn't say which names aren't split by chain`);
  }
}

// The full notes a card's tooltip must hold, by kind.
export function checkFullNotes(
  where: string,
  panel: Element,
  fullNotes: Record<string, string>,
  problems: string[],
) {
  for (const [kind, text] of Object.entries(fullNotes)) {
    const full = panel.querySelector(`.tip__panel [data-full-note="${kind}"]`);
    if (plainText(full) !== text)
      problems.push(`${where}: its tooltip has lost the ${kind} note in full`);
  }
}

export function checkHeadingOf(where: string, panel: Element, heading: string, problems: string[]) {
  const shown = panel.querySelector(".chart-card__head h2, .chart-card__head h3");
  if (viewText(shown).trim() !== heading)
    problems.push(`${where}: its heading isn't the dataset's`);
}
