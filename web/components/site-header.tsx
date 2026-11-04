import Link from "next/link";
import { INDEPENDENCE_LINE, SITE_NAME } from "@/lib/site";
import { Mark } from "./mark";

export function SiteHeader() {
  return (
    <header className="site-header">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <div className="site-header__inner">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Mark />
          {SITE_NAME}
        </Link>
        <p className="independence-line site-header__line">{INDEPENDENCE_LINE}</p>
        <nav aria-label="Site" className="ml-auto text-sm md:ml-0">
          <Link href="/methodology" className="underline underline-offset-4">
            Methodology
          </Link>
        </nav>
      </div>
    </header>
  );
}
