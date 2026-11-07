export const INDEPENDENCE_LINE = "Independent. Not affiliated with Open Standard or Bridge.";

export const FRESH_SENTENCE = "Supply reconciled on all 4 chains";

// Everything else is read as text, so a new kind of output file can't slip past unread.
export const BINARY_EXTENSIONS = new Set([
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".ico",
  ".png",
]);

export const EVM_ADDRESS = /0[xX][0-9a-fA-F]{40}(?![0-9a-zA-Z])/g;

export const BASE58_ADDRESS = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g;

export const CSS_REQUEST = /(url\(|@import)\s*['"]?(https?:)?\/\//;

export const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// A shorter string could match ordinary page text, and says nothing about a pipeline leak.
export const MIN_PIPELINE_STRING = 8;

export const REQUEST_ATTRIBUTES = [
  ["script", "src"],
  ["link", "href"],
  ["img", "src"],
  ["source", "src"],
  ["iframe", "src"],
  ["video", "src"],
  ["audio", "src"],
  ["embed", "src"],
  ["object", "data"],
  ["form", "action"],
];
