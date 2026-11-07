import Link from "next/link";
import type { DatasetState } from "@/lib/dataset/state";
import { BRIDGE_REPORTS_URL, INDEPENDENCE_LINE, REPO_URL } from "@/lib/site";
import { FooterStatus } from "./trust-strip";

// Two columns: what the site is on the left, what a reader can do on the right, each action level
// with a line. The independence line is here on every page, in view with nothing opened, as the
// project's rules require. They stack, in reading order, on a phone.
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
        <p className="independence-line site-footer__info">{INDEPENDENCE_LINE}</p>
        <div className="site-footer__action">
          <FooterStatus state={state} />
        </div>
        <p className="site-footer__info">Not financial advice. Not an attestation.</p>
        <nav aria-label="Footer" className="site-footer__action">
          <Link href="/methodology" className="target-link underline underline-offset-4">
            Methodology
          </Link>
        </nav>
        <p className="site-footer__info">
          For the issuer&rsquo;s own figures, see{" "}
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
          <p className="site-footer__action">
            <a href={repoUrl} rel="noopener noreferrer" className="underline underline-offset-4">
              Source code on GitHub
            </a>
          </p>
        ) : null}
      </div>
    </footer>
  );
}
