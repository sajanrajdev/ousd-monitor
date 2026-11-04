import { BRIDGE_REPORTS_URL, INDEPENDENCE_LINE, REPO_URL } from "@/lib/site";

export function SiteFooter({ repoUrl = REPO_URL }: { repoUrl?: string }) {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="independence-line">{INDEPENDENCE_LINE}</p>
        <p>Not financial advice.</p>
        <p>
          Not an attestation. For the issuer&rsquo;s own figures, see{" "}
          <a href={BRIDGE_REPORTS_URL} className="underline underline-offset-4">
            Bridge&rsquo;s reports
          </a>
          .
        </p>
        {repoUrl ? (
          <p>
            <a href={repoUrl} className="underline underline-offset-4">
              Source code on GitHub
            </a>
          </p>
        ) : null}
      </div>
    </footer>
  );
}
