import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
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
  chip: "fact",
  source: "Sample data",
  asOf: "2026-11-04T14:05:00Z",
  definitionHref: "/methodology#supply",
  frameWord: null,
  summary: "Ethereum holds 600 million and Base holds 400 million.",
  table,
  children: <svg data-testid="graphic" />,
};

describe("chart card", () => {
  it("renders the takeaway as a heading, then source, as-of time, a definition link and a table", () => {
    render(
      <main>
        <ChartCard {...props} />
      </main>,
    );

    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe(props.takeaway);
    expect(screen.getByText("Fact")).toBeTruthy();
    expect(screen.getByText(/Source: Sample data/)).toBeTruthy();
    expect(screen.getByText("4 Nov 2026, 14:05 UTC").getAttribute("datetime")).toBe(props.asOf);
    expect(screen.getByRole("link", { name: "Definition" }).getAttribute("href")).toBe(
      "/methodology#supply",
    );
    expect(screen.getByText(props.summary)).toBeTruthy();

    const accordion = screen.getByText("Table of the same data").closest("details")!;
    expect(within(accordion).getByRole("table", { name: table.caption })).toBeTruthy();
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

  it("says what to do without JavaScript", () => {
    const { container } = render(<ChartCard {...props} />);
    const noscript = container.querySelector("noscript")!;
    expect(noscript).not.toBeNull();
    expect(noscript.closest("[aria-hidden]")).toBeNull();
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
      // @ts-expect-error the chip is required
      { ...props, chip: undefined },
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

describe("a card's note", () => {
  const tableProps: TableCardProps = { ...props };

  it("on a chart card, is readable and outside the hidden graphic", () => {
    render(
      <main>
        <ChartCard {...props} note={<p>A chain with no label reads as zero here.</p>} />
      </main>,
    );
    const note = screen.getByText("A chain with no label reads as zero here.");
    expect(note.closest("[aria-hidden]")).toBeNull();
    expect(note.closest(".chart-card__note")).not.toBeNull();
    expect(note.closest("details")).toBeNull();
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
        <ChartCard {...props} />
        <TableCard {...tableProps} />
      </main>,
    );
    expect(container.querySelector(".chart-card__note")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <main>
        <ChartCard {...props} note="A note." />
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
