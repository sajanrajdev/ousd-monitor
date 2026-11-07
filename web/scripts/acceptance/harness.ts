import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { WEB_DIR } from "./constants.ts";

// Plain cards side by side, with a table too wide for half a card and nothing but what every card
// has, as the views' own cards differ until every unit is in. So this renders the real component with
// made-up amounts, and puts it in the built page, where the real CSS and enhancer apply. U3 dropped the
// filter and panels from here, as the page now has its own. Drop the rest when nothing needs it.
export type Harness = { markup: string; oneLineHeadline: string; close: () => Promise<void> };

export async function loadHarness(): Promise<Harness> {
  const vite = await createServer({
    root: WEB_DIR,
    configFile: false,
    appType: "custom",
    logLevel: "error",
    resolve: { alias: { "@": WEB_DIR.replace(/\/$/, "") } },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  const load = (path: string) => vite.ssrLoadModule(path);
  const [{ ChartCard }, verdict] = await Promise.all([
    load("/components/chart-card.tsx"),
    load("/lib/verdict.ts"),
  ]);
  const card = (name: string, props: Record<string, unknown>) => {
    const notes = [{ kind: "harness", text: `On ${name}, a made-up caveat.` }];
    return h(
      ChartCard,
      {
        takeaway: `A made-up finding about ${name}`,
        source: "Made-up data",
        asOf: "2026-11-03",
        definitionHref: "/methodology/#velocity",
        frameWord: "Sample",
        summary: `A made-up summary of ${name}.`,
        notes,
        table: {
          caption: `Made-up amounts for ${name}`,
          columns: ["Chain", "One", "Two", "Three", "Four", "Five", "Six", "Seven"].map(
            (label) => ({
              key: label,
              label,
              numeric: label !== "Chain",
            }),
          ),
          rows: [
            {
              Chain: name,
              One: "12345678901234567890",
              Two: "12345678901234567890",
              Three: "12345678901234567890",
              Four: "12345678901234567890",
              Five: "12345678901234567890",
              Six: "12345678901234567890",
              Seven: "12345678901234567890",
            },
          ],
        },
        ...props,
      },
      h("div", { "data-harness-chart": "" }, `A made-up chart of ${name}`),
    );
  };
  const markup = renderToStaticMarkup(
    h(
      "section",
      { "data-harness": "" },
      h(
        "div",
        { className: "card-grid" },
        card("no filter", { id: "harness-plain" }),
        card("its neighbour", { id: "harness-neighbour" }),
      ),
    ),
    { identifierPrefix: "harness-" },
  );
  return {
    markup,
    oneLineHeadline: verdict.VERDICT_SENTENCES.mostly_placed,
    close: () => vite.close(),
  };
}
