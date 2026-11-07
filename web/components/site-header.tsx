import Link from "next/link";
import { SITE_NAME } from "@/lib/site";
import { Mark } from "./mark";

// The mark and the name, which link home, and the methodology link at the far right. The independence
// line is in the footer.
export function SiteHeader() {
  return (
    <header className="site-header">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <div className="site-header__inner">
        <Link href="/" className="target-link gap-2 font-semibold">
          <Mark />
          {SITE_NAME}
        </Link>
        <nav aria-label="Site" className="site-header__nav">
          <Link href="/methodology" className="target-link underline underline-offset-4">
            Methodology
          </Link>
        </nav>
      </div>
    </header>
  );
}
