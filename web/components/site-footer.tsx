import Link from "next/link";
import type { DatasetState } from "@/lib/dataset/state";
import { BRIDGE_REPORTS_URL, INDEPENDENCE_LINE, REPO_URL } from "@/lib/site";
import { FooterStatus } from "./trust-strip";

// The independence line is here on every page, in view with nothing opened, as the project's rules
// require. So are the reconciliation status and the methodology link, which the header gave up.
export function SiteFooter({
  state,
  repoUrl = REPO_URL,
}: {
  state: DatasetState;
  repoUrl?: string;
}) {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="independence-line">{INDEPENDENCE_LINE}</p>
        <FooterStatus state={state} />
        <nav aria-label="Site">
          <Link href="/methodology" className="target-link underline underline-offset-4">
            Methodology
          </Link>
        </nav>
        <p>Not financial advice.</p>
        <p>
          Not an attestation. For the issuer&rsquo;s own figures, see{" "}
          <a
            href={BRIDGE_REPORTS_URL}
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            Bridge&rsquo;s reports
          </a>
          .
        </p>
        {repoUrl ? (
          <p>
            <a href={repoUrl} rel="noopener noreferrer" className="underline underline-offset-4">
              Source code on GitHub
            </a>
          </p>
        ) : null}
      </div>
    </footer>
  );
}
