#!/usr/bin/env bash
# Stage a reviewed source tree; activate only after dependency and readiness checks.
# Usage: deploy/push.sh user@host
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-${BETTER_BOTS_SSH_TARGET:-}}"
[[ "$TARGET" =~ ^[a-zA-Z0-9_@.:-]+$ ]] || { echo 'Supply an explicit SSH target: deploy/push.sh user@host' >&2; exit 1; }
EXPECTED="${BETTER_BOTS_EXPECTED_REMOTE:-}"
[[ -z "$EXPECTED" || "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid reviewed remote fingerprint' >&2; exit 1; }
STAGE=$(ssh "$TARGET" 'mktemp -d /tmp/better-bots-release.XXXXXXXX')
[[ "$STAGE" =~ ^/tmp/better-bots-release\.[a-zA-Z0-9]+$ ]] || { echo 'Invalid remote staging directory' >&2; exit 1; }
rsync -a --no-owner --no-group \
  --exclude node_modules --exclude .data --exclude .git --exclude .env --exclude '.env.*' \
  --exclude .opencode --exclude artifacts --exclude demo-data --exclude .video_agent \
  --exclude .better-bots-release.json "$ROOT/" "$TARGET:$STAGE/"
# Staging is retained for diagnosis if activation fails. On success, remove the staging copy.
ssh "$TARGET" "bash '$STAGE/deploy/activate.sh' '$STAGE' '$EXPECTED' && rm -rf '$STAGE'"
# Clean up any stale staging directories older than 24 hours on the remote target.
ssh "$TARGET" "find /tmp -maxdepth 1 -type d -name 'better-bots-release.*' -ctime +1 -exec rm -rf -- {} + 2>/dev/null || true"
