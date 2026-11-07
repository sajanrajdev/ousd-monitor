import Link from "next/link";

// Above a page's title: an arrow, named for assistive tech, back to the dashboard.
export function BackLink() {
  return (
    <Link href="/" className="back-link" aria-label="Back to the dashboard" data-back-link>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path
          d="M16.5 10h-13M8.5 5l-5 5 5 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Link>
  );
}
