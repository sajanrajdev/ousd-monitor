#!/usr/bin/env bash
# The daily run, as the hosted service starts it: the pipeline, then the release, then a Vercel
# preview of the verified release folder. Any failure exits non-zero, and nothing after a failed
# step runs, so a failed check deploys nothing and the live site keeps the last good data.
#
#   scripts/daily.sh
#
# Each step gets only the environment it needs:
#   make run          everything but the Vercel variables
#   make web-release  an allowlist, so no RPC variable reaches the site build
#   vercel deploy     the same allowlist plus the three Vercel variables
#
# No deploy when OUSD_DEPLOY=0 or VERCEL_TOKEN is unset: the release is still built and verified.
# The deploy is a preview, never production. It never prints a variable's value.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

started=$SECONDS
say() { printf '[daily %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() {
  say "FAILED: $*"
  exit 1
}

# What the site build and the Vercel CLI may see. Nothing that can hold a provider URL or key.
SAFE_VARS=(PATH HOME LANG LC_ALL TZ TMPDIR TERM NO_COLOR CI NODE_OPTIONS
  OUSD_ACK_WARNING_KEYS OUSD_ACK_WARNINGS)
VERCEL_VARS=(VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID)

# Runs a command with only the named variables exported. It unsets the rest in a subshell, so no
# value ever appears on a command line, where a process list could show it.
with_only() {
  local keep=" $1 "
  shift
  (
    local name
    for name in $(compgen -e); do
      case "$keep" in
        *" $name "*) ;;
        *) unset "$name" 2>/dev/null || true ;;
      esac
    done
    exec "$@"
  )
}

# An image has no checkout, so the commit comes from the deploy that built it. Railway's value
# always wins, so a commit typed into the service's variables can't outlive the deploy it named.
if [ -n "${RAILWAY_GIT_COMMIT_SHA:-}" ]; then
  export OUSD_GIT_COMMIT="$RAILWAY_GIT_COMMIT_SHA"
fi

say "Pipeline: make run (the Vercel variables are removed from its environment)."
env -u VERCEL_TOKEN -u VERCEL_ORG_ID -u VERCEL_PROJECT_ID make run ||
  fail "make run exited non-zero, so nothing is released or deployed."

say "Release: make web-release (allowlisted environment, no RPC variables)."
with_only "${SAFE_VARS[*]}" make web-release ||
  fail "make web-release refused or failed, so nothing is deployed."

release_dir="$ROOT/web/.release/latest"
[ -f "$release_dir/index.html" ] || fail "web/.release/latest has no index.html."

if [ "${OUSD_DEPLOY:-1}" = "0" ]; then
  say "Deploy skipped: OUSD_DEPLOY=0. The release is built and verified in web/.release/latest."
  say "Done in $((SECONDS - started))s."
  exit 0
fi
if [ -z "${VERCEL_TOKEN:-}" ]; then
  say "Deploy skipped: VERCEL_TOKEN is not set. The release is built and verified in web/.release/latest."
  say "Done in $((SECONDS - started))s."
  exit 0
fi
for name in VERCEL_ORG_ID VERCEL_PROJECT_ID; do
  [ -n "${!name:-}" ] || fail "$name is not set, so the Vercel project is unknown. Nothing is deployed."
done

# The verified folder, as the Build Output API wants it: static/ and config.json, nothing else.
# No vercel build, which would run next build again without the release gate.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/.vercel/output"
cp -RL "$release_dir/." "$work/.vercel/output/static"
printf '{"version": 3}\n' >"$work/.vercel/output/config.json"

say "Deploy: vercel deploy --prebuilt, a preview (token from the environment only)."
export VERCEL_TELEMETRY_DISABLED=1 NO_UPDATE_NOTIFIER=1
url="$(with_only "${SAFE_VARS[*]} ${VERCEL_VARS[*]} VERCEL_TELEMETRY_DISABLED NO_UPDATE_NOTIFIER" \
  vercel deploy --prebuilt --cwd "$work" --non-interactive)" ||
  fail "vercel deploy exited non-zero."
[ -n "$url" ] || fail "vercel deploy printed no deployment URL."

say "Preview deployed: $url"
say "Done in $((SECONDS - started))s."
