// Local only, and never run by `make check`. Reaches the built site in a real browser, with what a
// unit test can't see: layout, focus, hover, touch and the native behaviour with JavaScript off.
// Each unit adds its checks. Usage: acceptance.mjs [--widths=390,1440] [built folder ...], by default
// both samples at every width. Checks that need real data say "Not run" when no folder holds any.
// The checks are typed modules under acceptance/, one per view, and this is the entry point.
import { run } from "./acceptance/index.ts";

process.exit(await run(process.argv.slice(2)));
