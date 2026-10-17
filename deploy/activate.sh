#!/usr/bin/env bash
# Routine updates only. Fresh provisioning is a separate operation (deploy/bootstrap.sh).
set -euo pipefail
SOURCE="${1:?staged source directory required}"
EXPECTED="${2:-}"
APP_DIR="${BETTER_BOTS_APP_DIR:-/opt/better-bots}"
PARENT=$(dirname "$APP_DIR")
[ "$(id -u)" -eq 0 ] || { echo 'Activation requires root on the deployment host.' >&2; exit 1; }
[ -f "$APP_DIR/src/server.js" ] && systemctl cat better-bots >/dev/null 2>&1 || {
  echo 'Provision the host with deploy/bootstrap.sh before using the update command.' >&2; exit 1;
}
[ ! -L "$APP_DIR" ] || { echo 'Resolve the existing symlink deployment layout before updating.' >&2; exit 1; }
[ ! -e "$APP_DIR/.data" ] && [ ! -e "$APP_DIR/.env" ] || {
  echo 'Move application-local state/configuration outside the release directory before updating.' >&2; exit 1;
}
exec 9>"$PARENT/.better-bots-deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
FINGERPRINT=$(node "$SOURCE/deploy/release-manifest.mjs" verify "$APP_DIR" "$EXPECTED")
CANDIDATE=$(mktemp -d "$PARENT/.better-bots-release.XXXXXXXX")
cp -a "$SOURCE/." "$CANDIDATE/"
# The code runs from a root-owned tree, whatever owner the copy arrived with, and
# no package's install script ever runs as root.
chown -R root:root "$CANDIDATE"
chmod 0755 "$CANDIDATE"
(
  cd "$CANDIDATE"
  npm ci --ignore-scripts --no-audit --no-fund
  node --input-type=module -e "await import('ws'); await import('@anthropic-ai/sdk');"
  test -f node_modules/@novnc/novnc/core/rfb.js
  sudo -u better-bots env BETTER_BOTS_DESKTOP=placeholder BETTER_BOTS_CODEX_AUTH_FILE=/nonexistent/release-test-auth npm test
)
node "$SOURCE/deploy/release-manifest.mjs" write "$CANDIDATE"
# Detect edits made on the server while the candidate was being prepared.
node "$SOURCE/deploy/release-manifest.mjs" verify "$APP_DIR" "$FINGERPRINT" >/dev/null
PREVIOUS="$PARENT/better-bots-previous-$(date -u +%Y%m%dT%H%M%SZ)-$$"
FAILED="${CANDIDATE}-failed"
moved_old=false
stopped=false
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$moved_old" = true ]; then
    echo 'Activation failed; restoring the previous code and dependency release.' >&2
    systemctl stop better-bots || true
    if [ -e "$APP_DIR" ]; then mv "$APP_DIR" "$FAILED" || { echo 'Cannot preserve failed release; rollback needs operator attention.' >&2; exit 1; }; fi
    if mv "$PREVIOUS" "$APP_DIR" && systemctl start better-bots; then
      node "$SOURCE/deploy/readiness.mjs" || echo 'Previous code restored, but readiness remains unverified/degraded.' >&2
    else echo 'Rollback failed; operator action required. State was not restored or overwritten.' >&2; fi
  elif [ "$result" -ne 0 ] && [ "$stopped" = true ]; then
    systemctl start better-bots || echo 'Could not restart the unchanged release; operator action required.' >&2
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
systemctl stop better-bots
stopped=true
mv "$APP_DIR" "$PREVIOUS"
moved_old=true
mv "$CANDIDATE" "$APP_DIR"
systemctl start better-bots
node "$SOURCE/deploy/readiness.mjs"
# The release is healthy; housekeeping below must never trigger a rollback.
moved_old=false
stopped=false
echo "Release activated. Previous code and dependencies retained at $PREVIOUS"
# Retain at most two rollback releases in $PARENT; prune older ones to protect disk space.
while IFS= read -r old_release; do
  [ -n "$old_release" ] || continue
  rm -rf -- "$old_release" || echo "Could not remove $old_release; leaving it in place." >&2
done < <(find "$PARENT" -mindepth 1 -maxdepth 1 -type d -name 'better-bots-previous-*' | sort -r | tail -n +3)
# Clean up any abandoned release staging or failed candidates older than 1 day.
find "$PARENT" -mindepth 1 -maxdepth 1 -type d \( -name '.better-bots-release.*' -o -name '.better-bots-release.*-failed' \) -ctime +1 -exec rm -rf -- {} + 2>/dev/null || true
echo 'Production memory retention/recall acceptance is separate; see docs/MEMORY-CONTRACT.md.'
