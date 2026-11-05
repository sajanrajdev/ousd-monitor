import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChartCard,
  TableCard,
  type ChartCardProps,
  type TableCardProps,
} from "@/components/chart-card";
import { formatCompactUsd, formatUtcDate, formatUtcDateTime } from "@/components/chart-theme";
import { HairlineTable } from "@/components/hairline-table";

const table: ChartCardProps["table"] = {
  caption: "Sample supply by chain",
  columns: [
    { key: "chain", label: "Chain" },
    { key: "supply", label: "Supply", numeric: true },
  ],
  rows: [
    { chain: "Ethereum", supply: "600,000,000" },
    { chain: "Base", supply: "400,000,000" },
  ],
};

const props: ChartCardProps = {
  takeaway: "Most sample supply sits on two chains",
  source: "Sample data",
  asOf: "2026-11-04T14:05:00Z",
  definitionHref: "/methodology#supply",
  frameWord: null,
  summary: "Ethereum holds 600 million and Base holds 400 million.",
  table,
  children: <svg data-testid="graphic" />,
};

// The way verify-output reads a built page: with scripting off, so a noscript's children are elements.
function parsed(card: ReactElement): Document {
  return new DOMParser().parseFromString(renderToStaticMarkup(card), "text/html");
}

describe("chart card", () => {
  it("renders the takeaway as a heading and a visible as-of, and the rest on demand", () => {
    const { container } = render(
      <main>
        <ChartCard {...props} />
      </main>,
    );

    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe(props.takeaway);

    const meta = container.querySelector(".chart-card__meta")!;
    expect(meta.closest("details")).toBeNull();
    expect(meta.querySelector("time")!.textContent).toBe("4 Nov 2026, 14:05 UTC");
    expect(meta.querySelector("time")!.getAttribute("datetime")).toBe(props.asOf);
    expect(meta.textContent).not.toContain("Source:");

    const panel = container.querySelector(".tip__panel")!;
    expect(panel.textContent).toContain("Source: Sample data");
    expect(panel.textContent).toContain("As of 4 Nov 2026, 14:05 UTC");
    expect(panel.textContent).toContain(props.summary);
    expect(panel.querySelector("a")!.getAttribute("href")).toBe("/methodology#supply");

    const toggle = screen.getByText("Table").closest("details")!;
    expect(within(toggle).getByRole("table", { name: table.caption, hidden: true })).toBeTruthy();
  });

  it("keeps the takeaway in the card's head, outside its tooltip, with no marker", () => {
    const { container } = render(
      <main>
        <ChartCard {...props} />
        <TableCard {...props} />
      </main>,
    );
    const heads = container.querySelectorAll(".chart-card__head");
    expect(heads).toHaveLength(2);
    for (const head of heads) {
      const heading = head.querySelector(":scope > h2")!;
      expect(heading.textContent).toBe(props.takeaway);
      expect(heading.closest("details, .tip__panel")).toBeNull();
    }
    expect(container.querySelector(".status-chip")).toBeNull();
    expect(container.querySelector(".tip__panel h2")).toBeNull();
  });

  it("keeps the summary for assistive tech, visually hidden", () => {
    const { container } = render(<ChartCard {...props} />);
    const hidden = container.querySelector(".chart-card > .sr-only")!;
    expect(hidden.textContent).toBe(props.summary);
  });

  it("names the card on its tooltip's trigger and its toggle", () => {
    const { container } = render(<ChartCard {...props} />);
    expect(container.querySelector(".tip__icon")!.getAttribute("aria-label")).toBe(
      `About: ${props.takeaway}`,
    );
    expect(container.querySelector(".data-toggle > summary")!.textContent).toContain(
      `for ${props.takeaway}`,
    );
  });

  it("has source and definition in the noscript note, as verify-output parses it", () => {
    const note = parsed(<ChartCard {...props} />).querySelector(
      "noscript .chart-card__source-note",
    )!;
    expect(note.textContent).toContain("Source: Sample data");
    expect(note.querySelector("a")!.getAttribute("href")).toBe("/methodology#supply");
  });

  it("hides the graphic from assistive tech and the tab order", () => {
    render(
      <main>
        <ChartCard {...props} />
      </main>,
    );
    const area = screen.getByTestId("graphic").closest(".chart-area")!;

    expect(area.getAttribute("aria-hidden")).toBe("true");
    expect(area.querySelector("a, button, input, [tabindex]")).toBeNull();
  });

  it("says what to do without JavaScript only on a chart that needs it", () => {
    const needing = parsed(<ChartCard {...props} needsJs />).querySelector(
      ".chart-area__needs-js",
    )!;
    expect(needing.textContent).toBe(
      "This chart needs JavaScript. The Table button has the same data.",
    );
    expect(needing.closest("[aria-hidden]")).toBeNull();
    expect(needing.closest("noscript")).not.toBeNull();
    expect(parsed(<ChartCard {...props} />).querySelector(".chart-area__needs-js")).toBeNull();
  });

  it("hides the plot from assistive tech unless it is real content", () => {
    const { container, rerender } = render(<ChartCard {...props} />);
    const area = () => container.querySelector(".chart-area")!;
    expect(area().getAttribute("aria-hidden")).toBe("true");
    expect(area().hasAttribute("data-plot-content")).toBe(false);
    rerender(<ChartCard {...props} plotIsContent />);
    expect(area().hasAttribute("aria-hidden")).toBe(false);
    expect(area().hasAttribute("data-plot-content")).toBe(true);
  });

  it("gives the noscript definition link a 24px target", () => {
    const link = parsed(<ChartCard {...props} />).querySelector("noscript a")!;
    expect(link.className).toContain("target-link");
  });

  it("renders its pinned notes after the plot, and none when it has none", () => {
    const notes = [{ kind: "a-caveat", text: "On Tempo, a caveat." }];
    const { container, rerender } = render(<ChartCard {...props} notes={notes} />);
    const list = container.querySelector("[data-pinned-notes]")!;
    expect(list.previousElementSibling!.className).toBe("chart-card__plot");
    expect(list.closest("details")).toBeNull();
    expect(container.querySelector(".chart-card__body")!.hasAttribute("data-notes")).toBe(true);

    rerender(<ChartCard {...props} />);
    expect(container.querySelector("[data-pinned-notes]")).toBeNull();
    expect(container.querySelector(".chart-card__body")!.hasAttribute("data-notes")).toBe(false);
  });

  it("takes an anchor, more for the popover, and further tables under the toggle", () => {
    const { container } = render(
      <ChartCard
        {...props}
        id="where-supply-sits"
        detail={<p>The long takeaway.</p>}
        moreTables={<p data-testid="more">Another table</p>}
      />,
    );
    expect(container.querySelector(".chart-card")!.id).toBe("where-supply-sits");
    expect(container.querySelector(".tip__panel")!.textContent).toContain("The long takeaway.");
    expect(screen.getByTestId("more").closest(".data-toggle")).not.toBeNull();
  });

  it("keeps the frame word beside the as-of, on a table card too", () => {
    const { container } = render(
      <>
        <ChartCard {...props} frameWord="Sample" />
        <TableCard {...props} frameWord="Sample" />
      </>,
    );
    const metas = container.querySelectorAll(".chart-card__meta");
    expect(metas).toHaveLength(2);
    for (const meta of metas) {
      expect(meta.closest("details")).toBeNull();
      expect(meta.textContent).toContain("Sample");
    }
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <main>
        <h1>Page</h1>
        <ChartCard {...props} />
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it("does not compile without its required parts", () => {
    const missing: ChartCardProps[] = [
      // @ts-expect-error the source is required
      { ...props, source: undefined },
      // @ts-expect-error the table is required
      { ...props, table: undefined },
      // @ts-expect-error the as-of time is required
      { ...props, asOf: undefined },
      // @ts-expect-error the summary is required
      { ...props, summary: undefined },
      // @ts-expect-error the definition link is required
      { ...props, definitionHref: undefined },
      // @ts-expect-error the takeaway is required
      { ...props, takeaway: undefined },
    ];
    expect(missing).toHaveLength(6);
  });
});

describe("hairline table", () => {
  it("keeps a 20-digit amount whole in its stacked form", () => {
    const amount = "12345678901234567890";
    render(
      <HairlineTable
        caption="Exact amounts"
        columns={[{ key: "amount", label: "Amount", numeric: true }]}
        rows={[{ amount }]}
      />,
    );

    const cell = screen.getByText(amount);
    expect(cell.tagName).toBe("TD");
    expect(cell.getAttribute("data-label")).toBe("Amount");
    expect(cell.closest("table")!.className).toContain("hairline-table");
  });
});

describe("chart theme", () => {
  it("writes compact dollar ticks", () => {
    expect(formatCompactUsd(600_000_000)).toBe("$600M");
    expect(formatCompactUsd(1_500)).toBe("$1.5K");
    expect(formatCompactUsd(-5_000_000)).toBe("\u2212$5M");
  });

  it("labels dates as UTC whatever the local zone", () => {
    expect(formatUtcDate("2026-11-04T23:30:00-05:00")).toBe("5 Nov 2026 UTC");
    expect(formatUtcDateTime("2026-11-04T14:05:00Z")).toBe("4 Nov 2026, 14:05 UTC");
  });

  it("returns something that isn't a date unchanged", () => {
    expect(formatUtcDate("not a date")).toBe("not a date");
  });
});

describe("a table card's note", () => {
  const tableProps: TableCardProps = { ...props };

  it("is a table card's only: a chart card pins its caveats instead", () => {
    // @ts-expect-error A chart card has no note: its caveats are pinned notes.
    render(<ChartCard {...props} note="A note." />);
  });

  it("on a table card, is readable", () => {
    render(
      <main>
        <TableCard {...tableProps} note="We don't ingest swaps, so this can't show trading." />
      </main>,
    );
    const note = screen.getByText("We don't ingest swaps, so this can't show trading.");
    expect(note.closest("[aria-hidden]")).toBeNull();
    expect(note.closest(".chart-card__note")).not.toBeNull();
  });

  it("can hold a link", () => {
    render(
      <main>
        <TableCard {...tableProps} note={<a href="/methodology/#velocity">How velocity works</a>} />
      </main>,
    );
    expect(screen.getByRole("link", { name: "How velocity works" })).toBeTruthy();
  });

  it("leaves no empty slot when there's no note", () => {
    const { container } = render(
      <main>
        <TableCard {...tableProps} />
      </main>,
    );
    expect(container.querySelector(".chart-card__note")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <main>
        <TableCard {...tableProps} note="A note." />
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it("puts what goes beside the chart outside the hidden graphic, and the notes under both", () => {
    const { container } = render(
      <ChartCard
        {...props}
        beside={<ul data-testid="a-legend" />}
        notes={[{ kind: "a-note", text: "A note." }]}
      />,
    );
    const legend = screen.getByTestId("a-legend");
    expect(legend.closest("[aria-hidden]")).toBeNull();
    expect(legend.closest(".chart-card__plot")!.hasAttribute("data-beside")).toBe(true);
    expect(container.querySelector(".chart-card__body")!.hasAttribute("data-notes")).toBe(false);
    expect(container.querySelector(".chart-card__plot [data-pinned-notes]")).toBeNull();
  });
});
