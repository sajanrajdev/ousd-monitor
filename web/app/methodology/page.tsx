import type { Metadata } from "next";
import { UNKNOWN_TEXT } from "@/lib/format";

export const metadata: Metadata = { title: "Methodology" };

// A stub until unit 3.4.
export default function Methodology() {
  return (
    <main className="page-main">
      <h1 style={{ fontSize: "var(--text-h2)" }}>Methodology</h1>
      <p className="mt-3">{UNKNOWN_TEXT}</p>
    </main>
  );
}
