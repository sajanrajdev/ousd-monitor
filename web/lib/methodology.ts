// The methodology page's prose is docs/methodology.md, and nothing else. It is rendered at build,
// and the build fails on raw HTML, on a link that isn't https or in-page, and on a missing anchor.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Marked, type Token, type Tokens } from "marked";
import type { Definitions, LabelRow } from "./dataset/rows.ts";
import {
  CHAIN_NAMES,
  DEFAULT_DEFINITIONS,
  TOKEN_CONTRACTS,
  DEFINITION_ANCHORS,
  REQUIRED_CHAINS,
  type DefinitionAnchor,
} from "./definitions.ts";
import { UNKNOWN_TEXT } from "./format.ts";

const DOC_PATH = "../docs/methodology.md";

export class MethodologyError extends Error {
  constructor(rule: string) {
    super(`docs/methodology.md: ${rule}`);
    this.name = "MethodologyError";
  }
}

// The exact heading text for each fixed anchor. The type makes a new anchor a compile error here.
export const ANCHOR_HEADINGS: Record<DefinitionAnchor, string> = {
  verdict: "The verdict",
  "minted-burned": "Minted, burned and net issuance",
  "issuer-inventory": "Issuer inventory",
  "venue-supply": "Venue supply",
  "placed-supply": "Placed supply",
  "free-floating": "Free-floating supply",
  "circulating-supply": "Circulating supply",
  "headline-volume": "Headline volume",
  "clean-volume": "Clean volume",
  "everyday-large": "Everyday and large clean volume",
  "venue-flow": "Venue flow",
  "tempo-fee": "Tempo fee",
  velocity: "Velocity",
  "active-wallets": "Active wallets",
  concentration: "Concentration",
  "implied-reserve-income": "Implied reserve income",
  "chain-roles": "Chain roles",
  reconciliation: "Reconciliation",
  "known-limits": "Known limits",
  "source-legend": "How we know: the source legend",
  "named-labels": "Named labels",
  "unnamed-clusters": "Unnamed clusters",
  "fact-estimate-opinion": "Fact, estimate and opinion",
};

// Sections whose body in the doc is the same words as the dataset's, kept for readers on GitHub.
// The page shows the heading and then the dataset's version, so nothing appears twice.
export const MIRRORED_SECTIONS = [
  "source-legend",
  "limits-in-the-dataset",
  "limits-not-in-the-dataset",
  "the-rule",
  "documented-defaults",
] as const;
export type MirroredSection = (typeof MIRRORED_SECTIONS)[number];

// The verdict's thresholds, which tests hold equal to the pipeline's.
export const VERDICT_THRESHOLDS = { placed_bps: 5000, everyday_bps: 500 } as const;

export type Chunk = {
  id: string;
  title: string;
  // 0 is the opening text before the first heading. It has no heading.
  level: 0 | 2 | 3;
  headingHtml: string;
  bodyHtml: string;
};

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Passes if a link goes nowhere but the page itself or an https address.
function checkLink(href: string): void {
  const fail = () => {
    throw new MethodologyError(`a link isn't https or an in-page anchor: ${href.slice(0, 60)}`);
  };
  if (href.startsWith("#")) return;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" || url.username || url.password) fail();
}

function walk(tokens: Token[], visit: (token: Token) => void): void {
  for (const token of tokens) {
    visit(token);
    const nested = token as {
      tokens?: Token[];
      items?: Token[];
      header?: Tokens.TableCell[];
      rows?: Tokens.TableCell[][];
    };
    if (nested.tokens) walk(nested.tokens, visit);
    if (nested.items) walk(nested.items, visit);
    for (const cell of [...(nested.header ?? []), ...(nested.rows ?? []).flat()]) {
      walk(cell.tokens, visit);
    }
  }
}

// marked passes raw HTML through by default, and this file ships to every visitor.
function refuseUnsafe(tokens: Token[]): void {
  walk(tokens, (token) => {
    if (token.type === "html") throw new MethodologyError("raw HTML isn't allowed");
    if (token.type === "image") throw new MethodologyError("images aren't allowed");
    if (token.type === "link") checkLink((token as Tokens.Link).href);
  });
}

function styledRenderer(headingIds: Map<string, string>, caption: { current: string }) {
  return {
    heading(this: { parser: { parseInline(t: Token[]): string } }, token: Tokens.Heading) {
      const id = headingIds.get(token.text);
      const inner = this.parser.parseInline(token.tokens);
      const mark = "scroll-mt-4 target:bg-[var(--color-secondary-strong)]";
      if (token.depth === 2) {
        return `<h2 id="${id}" class="mt-2 ${mark}" style="font-size:var(--text-h2)">${inner}</h2>\n`;
      }
      return `<h3 id="${id}" class="mt-2 text-xl font-semibold ${mark}">${inner}</h3>\n`;
    },
    paragraph(this: { parser: { parseInline(t: Token[]): string } }, token: Tokens.Paragraph) {
      return `<p class="mt-3">${this.parser.parseInline(token.tokens)}</p>\n`;
    },
    list(
      this: {
        parser: { parse(t: Token[], top?: boolean): string };
        listitem(i: Tokens.ListItem): string;
      },
      token: Tokens.List,
    ) {
      const tag = token.ordered ? "ol" : "ul";
      const kind = token.ordered ? "list-decimal" : "list-disc";
      return `<${tag} class="mt-3 ${kind} pl-6">${token.items.map((item) => this.listitem(item)).join("")}</${tag}>\n`;
    },
    listitem(
      this: { parser: { parse(t: Token[], top?: boolean): string } },
      item: Tokens.ListItem,
    ) {
      return `<li class="mt-1">${this.parser.parse(item.tokens, !!item.loose)}</li>\n`;
    },
    codespan(token: Tokens.Codespan) {
      return `<code class="font-mono text-[0.9em] [overflow-wrap:anywhere]">${escapeHtml(token.text)}</code>`;
    },
    link(this: { parser: { parseInline(t: Token[]): string } }, token: Tokens.Link) {
      const inner = this.parser.parseInline(token.tokens);
      const outbound = token.href.startsWith("https://");
      const rel = outbound ? ' rel="noopener noreferrer"' : "";
      return `<a href="${escapeHtml(token.href)}"${rel} class="underline underline-offset-4">${inner}</a>`;
    },
    // The same markup as HairlineTable, so the stacked phone form works from data-label.
    table(this: { parser: { parseInline(t: Token[]): string } }, token: Tokens.Table) {
      const align = (cell: Tokens.TableCell) => (cell.align === "right" ? " data-numeric" : "");
      const head = token.header
        .map(
          (cell) =>
            `<th scope="col" role="columnheader"${align(cell)}>${this.parser.parseInline(cell.tokens)}</th>`,
        )
        .join("");
      const labels = token.header.map((cell) => escapeHtml(cell.text));
      const rows = token.rows
        .map((row) => {
          const cells = row
            .map(
              (cell, index) =>
                `<td role="cell" data-label="${labels[index] ?? ""}"${align(cell)}>${this.parser.parseInline(cell.tokens)}</td>`,
            )
            .join("");
          return `<tr role="row">${cells}</tr>`;
        })
        .join("");
      return (
        `<table class="hairline-table mt-3" role="table"><caption>${escapeHtml(caption.current)}</caption>` +
        `<thead role="rowgroup"><tr role="row">${head}</tr></thead>` +
        `<tbody role="rowgroup">${rows}</tbody></table>\n`
      );
    },
  };
}

function headingIdsFor(headings: Tokens.Heading[]): Map<string, string> {
  const fixed = new Map(Object.entries(ANCHOR_HEADINGS).map(([anchor, title]) => [title, anchor]));
  const found = new Set(headings.map((heading) => heading.text));
  for (const [anchor, title] of Object.entries(ANCHOR_HEADINGS)) {
    if (!found.has(title)) throw new MethodologyError(`no heading "${title}" for #${anchor}`);
  }
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const heading of headings) {
    const id = fixed.get(heading.text) ?? slugify(heading.text);
    if (!id || used.has(id))
      throw new MethodologyError(`the heading "${heading.text}" repeats an id`);
    used.add(id);
    ids.set(heading.text, id);
  }
  return ids;
}

// Only the four token contracts may appear. A shortened form such as 0x4c2c…00b8 has no long run.
const WALLET_SHAPE = /0[xX][0-9a-fA-F]{8,}|[1-9A-HJ-NP-Za-km-z]{32,}/;

function refuseWallets(markdown: string): void {
  let rest = markdown;
  for (const address of Object.values(TOKEN_CONTRACTS)) rest = rest.split(address).join("");
  if (WALLET_SHAPE.test(rest))
    throw new MethodologyError("a wallet address that isn't a token contract");
}

export function renderMethodology(markdown: string): Chunk[] {
  refuseWallets(markdown);
  const marked = new Marked();
  const tokens = marked.lexer(markdown);
  refuseUnsafe(tokens);

  const headings = tokens.filter((token): token is Tokens.Heading => token.type === "heading");
  for (const heading of headings) {
    if (heading.depth === 1) continue;
    if (heading.depth > 3) throw new MethodologyError("headings go no deeper than ###");
  }
  const ids = headingIdsFor(headings.filter((heading) => heading.depth > 1));

  const caption = { current: "" };
  const renderer = new Marked({ renderer: styledRenderer(ids, caption) });
  const chunks: Chunk[] = [];
  let current: { chunk: Chunk; tokens: Token[] } | null = null;
  const pending: { chunk: Chunk; tokens: Token[] }[] = [];
  const open = (chunk: Chunk) => {
    current = { chunk, tokens: [] };
    pending.push(current);
    chunks.push(chunk);
  };

  for (const token of tokens) {
    if (token.type === "heading" && token.depth === 1) continue;
    if (token.type === "heading") {
      const title = token.text;
      open({
        id: ids.get(title)!,
        title,
        level: token.depth as 2 | 3,
        headingHtml: renderer.parser([token]),
        bodyHtml: "",
      });
      continue;
    }
    if (token.type === "space") continue;
    if (!current)
      open({
        id: "about-this-page",
        title: "About this page",
        level: 0,
        headingHtml: "",
        bodyHtml: "",
      });
    (current as { tokens: Token[] } | null)?.tokens.push(token);
  }
  for (const { chunk, tokens: body } of pending) {
    caption.current = chunk.title;
    chunk.bodyHtml = renderer.parser(body);
  }
  return chunks;
}

export function loadMethodologyMarkdown(webRoot = process.cwd()): string {
  return readFileSync(resolve(webRoot, DOC_PATH), "utf8");
}

export function loadMethodology(webRoot = process.cwd()): Chunk[] {
  return renderMethodology(loadMethodologyMarkdown(webRoot));
}

// The legend's table rows and its "Reading a label" line, as written in a markdown file. The same
// two kinds of line are the whole of what the pipeline publishes, so equal lines mean equal words.
export function legendLines(markdown: string): string[] {
  const heading = `## ${ANCHOR_HEADINGS["source-legend"]}`;
  const start = markdown.search(new RegExp(`^${heading}$`, "m"));
  if (start < 0) throw new MethodologyError(`no section "${heading.slice(3)}"`);
  const section = markdown.slice(start + heading.length).split("\n## ")[0];
  return section
    .split("\n")
    .filter((line) => line.startsWith("| `") || line.startsWith("**Reading a label:**"));
}

// ---- Labels ----------------------------------------------------------------------------------

export const CATEGORY_NAMES: Record<LabelRow["category"], string> = {
  issuer: "Issuer",
  issuer_route: "Redemption route",
  system: "System",
  dex: "DEX",
  lending: "Lending",
  exchange: "Exchange",
};

export type NamedLabel = {
  entity: string;
  chain: LabelRow["chain"];
  category: LabelRow["category"];
  sourceType: string;
  sourceUrl: string;
  sourceHost: string;
  confidence: LabelRow["confidence"];
  dateChecked: string;
};

const chainOrder = (chain: string) =>
  REQUIRED_CHAINS.indexOf(chain as (typeof REQUIRED_CHAINS)[number]);

// One row per named label, by entity. A `derived_rule` row has no name and no link, so it only
// counts toward a cluster. Any other row without an https source stops the build and is not dropped.
export function namedLabels(rows: readonly LabelRow[]): NamedLabel[] {
  const named: NamedLabel[] = [];
  for (const row of rows) {
    if ((row.source_type as string) === "derived_rule") continue;
    let url: URL | null = null;
    try {
      url = new URL(row.source_url);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || url.username || url.password) {
      throw new MethodologyError(`a label on ${row.chain} has a source that isn't an https link`);
    }
    named.push({
      entity: row.entity,
      chain: row.chain,
      category: row.category,
      sourceType: row.source_type,
      sourceUrl: row.source_url,
      sourceHost: url.host,
      confidence: row.confidence,
      dateChecked: row.date_checked,
    });
  }
  return named.sort(
    (a, b) =>
      a.entity.localeCompare(b.entity) ||
      chainOrder(a.chain) - chainOrder(b.chain) ||
      a.category.localeCompare(b.category),
  );
}

export function labelsTakeaway(labels: readonly NamedLabel[]): string {
  if (labels.length === 0) return UNKNOWN_TEXT;
  const entities = new Set(labels.map((label) => label.entity)).size;
  const noun = (n: number, one: string, many: string) => (n === 1 ? one : many);
  return (
    `${labels.length} named ${noun(labels.length, "label", "labels")} on ${entities} ` +
    `${noun(entities, "entity", "entities")}, each with a public source you can open`
  );
}

export function latestCheck(labels: readonly NamedLabel[]): string | null {
  return labels.reduce<string | null>(
    (latest, label) => (latest === null || label.dateChecked > latest ? label.dateChecked : latest),
    null,
  );
}

// Unnamed clusters, by category, with the chains each is on.
export function clusterTotals(
  counts: readonly { chain: LabelRow["chain"]; category: LabelRow["category"]; count: number }[],
): { category: LabelRow["category"]; total: number; byChain: string }[] {
  const byCategory = new Map<LabelRow["category"], { chain: LabelRow["chain"]; count: number }[]>();
  for (const { chain, category, count } of counts) {
    byCategory.set(category, [...(byCategory.get(category) ?? []), { chain, count }]);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, chains]) => ({
      category,
      total: chains.reduce((sum, item) => sum + item.count, 0),
      byChain: chains
        .sort((a, b) => chainOrder(a.chain) - chainOrder(b.chain))
        .map((item) => `${CHAIN_NAMES[item.chain]} ${item.count}`)
        .join(", "),
    }));
}

// ---- Limits ----------------------------------------------------------------------------------

export type ExtraLimit = { id: string; text: string; measured: string | null; from: string };

// What the dataset doesn't carry. docs/methodology.md has the same words, and a test holds them equal.
export const EXTRA_LIMITS: readonly ExtraLimit[] = [
  {
    id: "base_balances_sample",
    text: "Base balances are checked on a sample of 50 wallets a run, not a census.",
    measured: "2026-11-04",
    from: "Build log, first full reconciliation",
  },
  {
    id: "blockscout_lag",
    text: "If Blockscout lags more than its 2,000 block tail, ordinary transfers can be missed, and only the sampled balance check would catch it.",
    measured: "2026-11-03",
    from: "Build log, known gaps",
  },
  {
    id: "log_index",
    text: "Whether Blockscout and the RPC give the same log index for a block hasn't been checked.",
    measured: null,
    from: "Build log, known gaps",
  },
  {
    id: "placed_lag",
    text: "Placed supply lags by 14 days, and isn't charted before its first valid day, 2026-10-14.",
    measured: null,
    from: "Methodology",
  },
  {
    id: "large_transfers",
    text: "A few large transfers dominate clean volume: 81 Tempo transactions were 97% of its clean volume. Those inspected looked like holders moving balances between wallets, which public evidence can't confirm.",
    measured: "2026-11-03",
    from: "Adoption metrics brainstorm",
  },
  {
    id: "tempo_fee_sample",
    text: "The Tempo fee rule was tested on 350 random rows with no misses, so its true miss rate is below about 0.9% by count at 95% confidence, and well under a dollar is at risk.",
    measured: "2026-11-03",
    from: "Adoption metrics brainstorm",
  },
  {
    id: "dex_not_trading",
    text: "DEX flow isn't trading volume, and we ingest no swaps.",
    measured: null,
    from: "Methodology",
  },
  {
    id: "small_ticket",
    text: "Bridge's small-ticket issuance is excluded from clean volume, as issuer flows are, and this version doesn't show it live. On Tempo, transfers under $100K from the hub wallet that mints go to rose from 93 in the week of 5 October to 2,441 in the week of 26 October, which may be on-ramp use. That is unproven.",
    measured: "2026-11-03",
    from: "Adoption metrics brainstorm",
  },
  {
    id: "stale_note",
    text: "A stale note appears only once a rebuild or the reader's clock shows it, so a failed run can take up to 36 hours to show on a page that wasn't rebuilt.",
    measured: null,
    from: "Methodology",
  },
];

// Known limits that appear in a dataset only when coverage calls for them. The rest are always there.
export const CONDITIONAL_LIMIT_IDS = [
  "no_issuer_row",
  "no_issuer_label",
  "local_preview",
  "chains_missing",
] as const;

// Dataset limits that state a measured figure, and the day it was measured.
export const DATASET_LIMIT_MEASURED: Record<string, string> = {
  lost_transfer_can_pass: "2026-11-04",
};

// ---- Settings --------------------------------------------------------------------------------

export type SettingRow = { name: string; value: string; documented: string; same: boolean };

const SETTING_NAMES = [
  "placed_days",
  "placed_min_base_units",
  "large_transfer_base_units",
  "active_dust_base_units",
  "active_secondary_base_units",
  "clean_tx_min_base_units",
  "journey_first_day",
] as const;

const VELOCITY_NAMES = ["velocity_bps", "velocity_everyday_bps", "headline_velocity_bps"] as const;

const formula = (part: { numerator: string; denominator: string }) =>
  `${part.numerator} over ${part.denominator}`;

// The dataset's values beside the documented defaults. An amount stays a string.
export function settingRows(definitions: Definitions): SettingRow[] {
  const rows: SettingRow[] = SETTING_NAMES.map((name) => {
    const value = String(definitions[name]);
    const documented = String(DEFAULT_DEFINITIONS[name]);
    return { name, value, documented, same: value === documented };
  });
  for (const name of VELOCITY_NAMES) {
    const value = formula(definitions.velocity[name]);
    const documented = formula(DEFAULT_DEFINITIONS.velocity[name]);
    rows.push({ name, value, documented, same: value === documented });
  }
  return rows;
}

export function settingsTakeaway(rows: readonly SettingRow[]): string {
  if (rows.length === 0) return UNKNOWN_TEXT;
  return rows.every((row) => row.same)
    ? "This dataset was built with the documented defaults"
    : "This dataset was built with settings that differ from the documented defaults";
}

export function sectionList(
  chunks: readonly Chunk[],
): { id: string; title: string; children: Chunk[] }[] {
  const items: { id: string; title: string; children: Chunk[] }[] = [];
  const fixed = new Set<string>(DEFINITION_ANCHORS);
  for (const chunk of chunks) {
    if (chunk.level === 2) items.push({ id: chunk.id, title: chunk.title, children: [] });
    else if (chunk.level === 3 && fixed.has(chunk.id)) items.at(-1)?.children.push(chunk);
  }
  return items;
}
