#!/usr/bin/env bash
# The daily run, as the hosted service starts it: the pipeline, then the release, then a Vercel
# preview of the verified release folder, then that preview promoted to production. Any failure
# exits non-zero, and nothing after a failed step runs, so a failed check deploys nothing and the
# live site keeps the last good data.
#
#   scripts/daily.sh
#
# Each step gets only the environment it needs:
#   make run          everything but the Vercel variables; its dbt build gets an allowlist
#   make web-release  an allowlist, so no RPC variable reaches the site build
#   vercel deploy     the same allowlist plus the three Vercel variables
#   vercel promote    the same as vercel deploy
#
# OUSD_DEPLOY=0, or no VERCEL_TOKEN off Railway, builds and verifies the release without deploying.
# On Railway a missing token fails the run. The deploy is a preview: a deployment that lands in
# production fails the run, so production only ever comes from promoting a preview that is ready.
# OUSD_PROMOTE=0 stops at the preview. It never prints a variable's value.
#
# A failure the pipeline didn't alert on raises an alert (`ousd alert`), an unexpected exit
# included, and only a run that got all the way through pings the heartbeat (`ousd heartbeat`).
# Both read their URLs from the environment, so no URL is ever on a command line here.
set -euo pipefail
# Every file and folder the run creates is its user's alone, so nothing new under data/ is group
# or world readable. The release is read back only by the same user, to verify and upload it.
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

started=$SECONDS
say() { printf '[daily %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() {
  say "FAILED: $*"
  exit 1
}

# The pipeline's own CLI, with what make run gets: everything but the Vercel variables.
ENV_FILE=()
[ -f .env ] && ENV_FILE=(--env-file .env)
ousd() {
  env -u VERCEL_TOKEN -u VERCEL_ORG_ID -u VERCEL_PROJECT_ID \
    uv run --locked ${ENV_FILE[@]+"${ENV_FILE[@]}"} ousd "$@"
}
# Set once this run has an alert, raised here or by the pipeline, so the exit trap adds none.
alerted=0
alert_and_fail() {
  local step="$1"
  shift
  alerted=1
  ousd alert --step "$step" --reason "$*" || say "The alert could not be raised."
  fail "$@"
}
# The number of alert files. Never fails: a missing or unreadable folder counts what it can.
alerts_in() {
  local count
  count="$(find data/alerts -name '*.json' 2>/dev/null | wc -l)" || true
  echo $((count))
}
finish() {
  ousd heartbeat || say "The heartbeat was not delivered."
  say "Done in $((SECONDS - started))s."
  exit 0
}
# The one exit trap: it removes the deploy's work folder, and alerts on an exit nothing alerted
# on, such as a command failing under set -e. The alert is best effort and keeps the status.
work=""
on_exit() {
  local status=$?
  [ -z "$work" ] || rm -rf "$work" || true
  if [ "$status" -ne 0 ] && [ "$alerted" = 0 ]; then
    alerted=1
    ousd alert --step daily --reason "scripts/daily.sh stopped unexpectedly with status $status." ||
      say "The alert could not be raised."
  fi
  exit "$status"
}
trap on_exit EXIT

# What the site build and the Vercel CLI may see. Nothing that can hold a provider URL or key.
SAFE_VARS=(PATH HOME LANG LC_ALL TZ TMPDIR TERM NO_COLOR CI
  OUSD_ACK_WARNING_KEYS OUSD_ACK_WARNINGS)
VERCEL_VARS=(VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID)

# Runs a command with only the named variables exported. It unsets the rest in a subshell, so no
# value ever appears on a command line, where a process list could show it. It fails closed: if the
# names can't be listed, or anything outside the list survives, the command doesn't run.
with_only() {
  local keep=" $1 "
  shift
  (
    local name names
    names="$(compgen -e)" || exit 97
    for name in $names; do
      case "$keep" in
        *" $name "*) ;;
        *) unset "$name" 2>/dev/null || true ;;
      esac
    done
    # Entries whose names aren't shell identifiers can't be unset, but would still reach the child.
    if env | grep -qE '^[^=]*[^A-Za-z0-9_=][^=]*='; then
      echo "The environment holds a variable whose name isn't an identifier; refusing to run." >&2
      exit 97
    fi
    for name in $(compgen -e); do
      case "$keep" in
        *" $name "*) ;;
        *)
          echo "Couldn't remove $name from the environment; refusing to run." >&2
          exit 97
          ;;
      esac
    done
    exec "$@"
  )
}

case "${OUSD_DEPLOY:-1}" in
  0 | 1) ;;
  *) alert_and_fail config "OUSD_DEPLOY must be 0 or 1." ;;
esac
case "${OUSD_PROMOTE:-1}" in
  0 | 1) ;;
  *) alert_and_fail config "OUSD_PROMOTE must be 0 or 1." ;;
esac
# The site reads data/published/latest, so the pipeline must publish there.
for name in OUSD_PUBLISHED_DIR OUSD_DATASET_DIR; do
  [ -z "${!name+x}" ] || alert_and_fail config "$name is set. The daily run publishes and releases the default path only."
done

# An image has no checkout, so the commit comes from the deploy that built it. Railway's value
# always wins, so a commit typed into the service's variables can't outlive the deploy it named.
if [ -n "${RAILWAY_GIT_COMMIT_SHA:-}" ]; then
  export OUSD_GIT_COMMIT="$RAILWAY_GIT_COMMIT_SHA"
fi

latest_before="$(readlink data/published/latest 2>/dev/null || true)"

alerts_before="$(alerts_in)"
# A blank heartbeat URL, which wins over .env: the run is fully successful only once deployed.
say "Pipeline: make run (the Vercel variables are removed from its environment)."
if ! env -u VERCEL_TOKEN -u VERCEL_ORG_ID -u VERCEL_PROJECT_ID OUSD_HEARTBEAT_URL= make run; then
  # The pipeline alerts on a failed step. One that failed before any step ran alerts here.
  [ "$(alerts_in)" != "$alerts_before" ] ||
    alert_and_fail pipeline "make run exited non-zero, so nothing is released or deployed."
  # The pipeline's own alert covers this exit.
  alerted=1
  fail "make run exited non-zero, so nothing is released or deployed."
fi

latest_after="$(readlink data/published/latest 2>/dev/null || true)"
[ -n "$latest_after" ] && [ "$latest_after" != "$latest_before" ] ||
  alert_and_fail pipeline "make run passed but published no new dataset, so nothing is released or deployed."
say "Published dataset: $latest_after."

say "Release: make web-release (allowlisted environment, no RPC variables)."
with_only "${SAFE_VARS[*]}" make web-release ||
  alert_and_fail release "make web-release refused or failed, so nothing is deployed."

release_dir="$ROOT/web/.release/latest"
[ -f "$release_dir/index.html" ] || alert_and_fail release "web/.release/latest has no index.html."

if [ "${OUSD_DEPLOY:-1}" = "0" ]; then
  say "Deploy skipped: OUSD_DEPLOY=0. The release is built and verified in web/.release/latest."
  finish
fi
if [ -z "${VERCEL_TOKEN:-}" ]; then
  [ -z "${RAILWAY_ENVIRONMENT_ID:-}" ] ||
    alert_and_fail deploy "VERCEL_TOKEN is not set on Railway. Set it, or OUSD_DEPLOY=0 to build without deploying."
  say "Deploy skipped: VERCEL_TOKEN is not set. The release is built and verified in web/.release/latest."
  finish
fi
for name in VERCEL_ORG_ID VERCEL_PROJECT_ID; do
  [ -n "${!name:-}" ] || alert_and_fail deploy "$name is not set, so the Vercel project is unknown. Nothing is deployed."
done

# The verified folder, as the Build Output API wants it: static/ and config.json, nothing else.
# config.json carries the security headers, with the hash of each inline script in the copied folder
# that is uploaded.
# No vercel build, which would run next build again without the release gate.
work="$(mktemp -d)"
mkdir -p "$work/.vercel/output"
cp -RL "$release_dir/." "$work/.vercel/output/static"
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$ROOT/web/scripts/vercel-config.mjs" "$work/.vercel/output/static" >"$work/.vercel/output/config.json" ||
  alert_and_fail deploy "web/scripts/vercel-config.mjs could not write the deploy config."
# Under umask 077 the copy is 600, and the Vercel CLI uploads each file with its mode. $work is a 700
# directory, so opening the modes exposes nothing on this host.
chmod -R u=rwX,go=rX "$work/.vercel/output"

say "Deploy: vercel deploy --prebuilt, a preview (token from the environment only)."
export VERCEL_TELEMETRY_DISABLED=1 NO_UPDATE_NOTIFIER=1
# In non-interactive mode the CLI prints one JSON result, also on failure. Read it either way.
status=0
result="$(with_only "${SAFE_VARS[*]} ${VERCEL_VARS[*]} VERCEL_TELEMETRY_DISABLED NO_UPDATE_NOTIFIER" \
  vercel deploy --prebuilt --cwd "$work" --non-interactive)" || status=$?
url="$(printf '%s' "$result" | node "$ROOT/scripts/deploy-result.mjs")" ||
  alert_and_fail deploy "vercel deploy did not make a preview (see the run's log)."
[ "$status" -eq 0 ] || alert_and_fail deploy "vercel deploy exited $status."

say "Preview deployed: $url"

if [ "${OUSD_PROMOTE:-1}" = "0" ]; then
  say "Promotion skipped: OUSD_PROMOTE=0. Production keeps its current deployment."
  finish
fi

say "Promote: vercel promote, as every check and the release gate passed."
with_only "${SAFE_VARS[*]} ${VERCEL_VARS[*]} VERCEL_TELEMETRY_DISABLED NO_UPDATE_NOTIFIER" \
  vercel promote "$url" --yes --non-interactive --timeout 5m ||
  alert_and_fail deploy "vercel promote failed, so production keeps the last good release."

say "Promoted to production: $url"
finish
