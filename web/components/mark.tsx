// Our own mark: a stepped line, since supply changes in discrete events.
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="22" height="22" rx="4" />
      <path d="M5 17h5v-5h4V8h5" />
    </svg>
  );
}
