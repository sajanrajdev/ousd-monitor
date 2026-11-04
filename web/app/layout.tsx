import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource-variable/newsreader";
import "./globals.css";
import { DatasetBanner, StaleNote } from "@/components/dataset-banner";
import { FreshnessWatch } from "@/components/freshness";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getDataset } from "@/lib/dataset";
import { SITE_NAME } from "@/lib/site";

const DESCRIPTION =
  "An independent look at whether Open USD (OUSD) supply is turning into money that moves.";

// The title's word and noindex come from the data, with no setting to turn them off.
export function generateMetadata(): Metadata {
  const { frameWord } = getDataset().state;
  const mark = frameWord ? `[${frameWord}] ` : "";
  return {
    title: { default: `${mark}${SITE_NAME}`, template: `${mark}%s | ${SITE_NAME}` },
    description: DESCRIPTION,
    ...(frameWord ? { robots: { index: false, follow: false } } : {}),
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const { state, manifest } = getDataset();
  return (
    <html
      lang="en"
      data-dataset-kind={state.kind}
      data-dataset-version={manifest.dataset_version}
      data-frame={state.frameWord ?? undefined}
      data-freshness={state.freshness}
    >
      <body>
        <FreshnessWatch clock={state.clock} />
        <SiteHeader />
        <DatasetBanner state={state} />
        <StaleNote state={state} />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
