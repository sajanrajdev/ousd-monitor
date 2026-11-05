import Link from "next/link";
import { SITE_NAME } from "@/lib/site";
import { Mark } from "./mark";

// Only the mark and the name. The independence line and the methodology link are in the footer.
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
      </div>
    </header>
  );
}
