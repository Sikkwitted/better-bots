#!/usr/bin/env bash
# Install Better Bots on this Mac.
#
# The host runs in the background as a login item (a LaunchAgent), so bots keep
# working when the window is closed. "Better Bots.app" in ~/Applications opens it
# in its own window, already signed in. Run it again from a newer checkout to
# update: the code is replaced, the data folder is kept.
#
#   ./install.sh                  (from the top of the checkout)
#   ./install.sh --uninstall      stops the host and removes the app; keeps your data
#
# Needs Node.js 22.13+ (brew install node) and the Xcode command line tools.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPPORT="$HOME/Library/Application Support/Better Bots"
APP_DIR="$SUPPORT/app"
DATA_DIR="$SUPPORT/data"
LOGS="$HOME/Library/Logs/Better Bots"
PORT="${BETTER_BOTS_PORT:-4173}"
LABEL=com.betterbots.host
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APPS="$HOME/Applications"
DOMAIN="gui/$(id -u)"

[ "$(uname -s)" = Darwin ] || { echo "This installer is for macOS." >&2; exit 1; }

if [ "${1:-}" = --uninstall ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$APPS/Better Bots.app" "$APP_DIR"
  echo "Better Bots is stopped and removed. Your bots and memory are still in:"
  echo "  $DATA_DIR"
  exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Better Bots needs Node.js 22.13 or later. Install it with: brew install node" >&2; exit 1; }
"$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
  || { echo "Node $("$NODE" -v) is too old; Better Bots needs 22.13 or later: brew upgrade node" >&2; exit 1; }
command -v swiftc >/dev/null || { echo "The Xcode command line tools are needed: xcode-select --install" >&2; exit 1; }

# Another program on the port would answer instead of Better Bots.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "Port $PORT is already in use by another program. Stop it, or run: BETTER_BOTS_PORT=<free port> ./install.sh" >&2
  exit 1
fi

echo "==> Better Bots code -> $APP_DIR"
mkdir -p "$APP_DIR" "$LOGS"
mkdir -p -m 700 "$DATA_DIR"
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude .data --exclude demo-data --exclude artifacts \
  --exclude .env --exclude '.env.*' "$ROOT/" "$APP_DIR/"
(cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

echo "==> background host (login item $LABEL)"
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$(xml "$NODE")</string><string>$(xml "$APP_DIR/src/server.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$APP_DIR")</string>
  <key>EnvironmentVariables</key><dict>
    <key>BETTER_BOTS_DIR</key><string>$(xml "$DATA_DIR")</string>
    <key>BETTER_BOTS_PORT</key><string>$PORT</string>
    <key>PATH</key><string>$(xml "$(dirname "$NODE")"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOGS/host.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/host.log")</string>
</dict></plist>
PLIST
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"

# The host writes its console token on first start; the app signs in with it.
for _ in $(seq 1 60); do
  [ -s "$DATA_DIR/console-token" ] && curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
[ -s "$DATA_DIR/console-token" ] || { echo "The host did not start. See $LOGS/host.log" >&2; exit 1; }

echo "==> Better Bots.app -> $APPS"
mkdir -p "$APPS"
BB_URL="http://127.0.0.1:$PORT" BETTER_BOTS_DIR="$DATA_DIR" bash "$ROOT/tools/make-app.sh" "$APPS" >/dev/null
open "$APPS/Better Bots.app"
echo "Installed. Open Better Bots from Launchpad or ~/Applications; it signs in by itself."
echo "Bots keep working when the window is closed. To remove: ./install.sh --uninstall"
