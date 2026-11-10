#!/usr/bin/env bash
# Fresh-machine Mint 22 installer. Do not use to upgrade an existing deployment.
set -Eeuo pipefail
trap 'echo "Installation stopped at line $LINENO. Existing files were preserved; inspect the error before retrying." >&2' ERR
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Memory runs on the built-in SQLite store. Hindsight is an opt-in extra, and
# everything it adds carries a Better Bots name so an existing Hindsight or
# PostgreSQL on this computer is left alone.
CHECK_ONLY=0
WITH_HINDSIGHT=0
HINDSIGHT_PORT=8888
REPLACE_NODE=0

usage() { echo 'Usage: bash install.sh [--check] [--replace-node] [--with-hindsight [--hindsight-port PORT]]' >&2; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) CHECK_ONLY=1 ;;
      --with-hindsight) WITH_HINDSIGHT=1 ;;
      --replace-node) REPLACE_NODE=1 ;;
      --hindsight-port) [ $# -ge 2 ] || { usage; return 1; }; HINDSIGHT_PORT="$2"; shift ;;
      *) usage; return 1 ;;
    esac
    shift
  done
  [[ "$HINDSIGHT_PORT" =~ ^[0-9]+$ ]] && [ "$HINDSIGHT_PORT" -ge 1024 ] && [ "$HINDSIGHT_PORT" -le 65535 ] && [ "$HINDSIGHT_PORT" -ne 4173 ] || {
    echo "Not a usable Hindsight port: $HINDSIGHT_PORT" >&2; return 1;
  }
}

# Bots work without asking. Say so, and install only after a typed yes.
# BETTER_BOTS_ACCEPT_AUTONOMY=yes answers for an unattended install.
confirm_autonomy() {
  cat <<'EOF'

  Better Bots bots work on their own.

  Give a bot a task and it keeps working until the task is done. It uses the
  tools on the computer Better Bots is installed on without asking you first.
  If that's this computer, that means your files, your apps and your accounts:
  bots can read and change files, run commands, use the internet, and send,
  post, delete, pay and change passwords with the accounts you connect.

  Install it only on a computer you're comfortable letting bots use, and keep
  backups. To make bots ask first, open App settings > Permissions and choose Ask.

EOF
  [ "${BETTER_BOTS_ACCEPT_AUTONOMY:-}" != yes ] || return 0
  if ! { : < /dev/tty; } 2>/dev/null; then
    echo 'There is no terminal to answer on. To install anyway, run with BETTER_BOTS_ACCEPT_AUTONOMY=yes.' >&2
    return 1
  fi
  local answer
  read -r -p '  Type yes to install: ' answer < /dev/tty
  [ "$answer" = yes ] || { echo 'Not installed.' >&2; return 1; }
}

# NodeSource's Node 22 replaces the distribution's nodejs, and apt then removes
# Ubuntu's npm with every package that depends on it (eslint, webpack and the
# like). Say so before anything changes rather than in the middle of apt output.
check_node_replacement() {
  [ "${REPLACE_NODE:-0}" = 1 ] && return 0
  command -v node >/dev/null || return 0
  [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ] || return 0
  dpkg-query -W -f='${Status}' npm 2>/dev/null | grep -q 'install ok installed' || return 0
  echo "Node $(node --version) and Ubuntu's npm package are installed. Better Bots needs Node 22, and installing it" >&2
  echo "removes Ubuntu's npm and the packages that depend on it (for example eslint or webpack). Nothing was changed." >&2
  echo 'Re-run with --replace-node to accept that, or install Node 22 yourself first.' >&2
  return 1
}

check_platform() {
  [ "$(uname -s)" = Linux ] || { echo 'This installer runs on Linux Mint 22.x.' >&2; return 1; }
  [ "$(uname -m)" = x86_64 ] || { echo 'This package targets 64-bit Intel/AMD computers.' >&2; return 1; }
  . "${1:-/etc/os-release}"
  [ "${ID:-}" = linuxmint ] && [[ "${VERSION_ID:-}" = 22 || "${VERSION_ID:-}" = 22.* ]] && [ "${UBUNTU_CODENAME:-}" = noble ] || {
    echo 'This alpha targets Linux Mint 22.x (Ubuntu 24.04 base), not Mint 21.x or LMDE.' >&2; return 1;
  }
  [ -d /run/systemd/system ] || { echo 'A running systemd desktop is required.' >&2; return 1; }
  local items=(/opt/better-bots /var/lib/better-bots /etc/better-bots.env /etc/systemd/system/better-bots.service
    /etc/systemd/system/better-bots.service.d /usr/local/bin/better-bots-open /usr/local/bin/better-bots-backup
    /usr/share/applications/better-bots.desktop)
  local accounts=(better-bots) units=(better-bots) ports=(4173)
  if [ "${WITH_HINDSIGHT:-0}" = 1 ]; then
    items+=(/opt/better-bots-hindsight /var/lib/better-bots-hindsight /etc/systemd/system/better-bots-hindsight.service)
    accounts+=(better-bots-hindsight); units+=(better-bots-hindsight); ports+=("${HINDSIGHT_PORT:-8888}")
  fi
  for item in "${items[@]}"; do
    [ ! -e "$item" ] && [ ! -L "$item" ] || { echo "Existing installation path: $item. Left unchanged." >&2; return 1; }
  done
  for account in "${accounts[@]}"; do
    if getent passwd "$account" >/dev/null; then echo "Existing $account account; manual review required." >&2; return 1; fi
  done
  for unit in "${units[@]}"; do
    [ "$(systemctl show "$unit.service" --property=LoadState --value)" = not-found ] || { echo "Existing $unit service; left unchanged." >&2; return 1; }
  done
  check_node_replacement
  command -v python3 >/dev/null || { echo 'Python 3 is required (included in Mint).' >&2; return 1; }
  python3 - "${ports[@]}" <<'PY'
import socket, sys
for port in map(int, sys.argv[1:]):
    with socket.socket() as sock:
        # As Node does: closed connections in TIME_WAIT must not count as in use;
        # a listener still blocks the bind.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try: sock.bind(('127.0.0.1', port))
        except OSError: raise SystemExit(f'Port {port} is already in use; nothing installed.')
PY
}

install_hindsight() {
  # PostgreSQL may already be here for something else. Better Bots gets its own
  # role and database in the 16/main cluster, on whatever port that cluster uses.
  useradd --system --home /var/lib/better-bots-hindsight --shell /usr/sbin/nologin better-bots-hindsight
  install -d -o better-bots-hindsight -g better-bots-hindsight -m 0750 /var/lib/better-bots-hindsight /var/lib/better-bots-hindsight/hf /var/lib/better-bots-hindsight/flashrank
  install -d -m 0755 /opt/better-bots-hindsight
  python3 -m venv /opt/better-bots-hindsight/venv
  /opt/better-bots-hindsight/venv/bin/pip install 'hindsight-api-slim[local-onnx]==0.9.2' 'flashrank==0.2.10'
  chmod -R go=rX /opt/better-bots-hindsight/venv
  systemctl enable --now postgresql@16-main.service
  local pg_port
  pg_port=$(pg_conftool -s 16 main show port)
  pg_isready -h 127.0.0.1 -p "$pg_port"
  python3 /opt/better-bots/configure-memory.py "$HINDSIGHT_PORT" "$pg_port"
  cat > /etc/systemd/system/better-bots-hindsight.service <<'UNIT'
[Unit]
Description=Better Bots Hindsight memory
After=network-online.target postgresql@16-main.service
Wants=network-online.target
Requires=postgresql@16-main.service
[Service]
User=better-bots-hindsight
Group=better-bots-hindsight
WorkingDirectory=/var/lib/better-bots-hindsight
EnvironmentFile=/var/lib/better-bots-hindsight/hindsight.env
ExecStart=/opt/better-bots-hindsight/venv/bin/hindsight-api
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/better-bots-hindsight
[Install]
WantedBy=multi-user.target
UNIT
  chmod 644 /etc/systemd/system/better-bots-hindsight.service
  BACKUP_ENV="BETTER_BOTS_BACKUP_DATABASE=better_bots_hindsight BETTER_BOTS_BACKUP_PGPORT=$pg_port"
  systemctl daemon-reload
  systemctl enable --now better-bots-hindsight
  printf 'Waiting for memory startup; the first run downloads embedding and reranking models'
  local ready=0
  for _ in $(seq 1 120); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$HINDSIGHT_PORT/health" >/dev/null 2>&1; then ready=1; break; fi
    printf '.'
    sleep 5
  done
  printf '\n'
  [ "$ready" -eq 1 ] || { echo 'Memory startup failed. Inspect: journalctl -u better-bots-hindsight' >&2; exit 1; }
}

main() {
parse_args "$@"
check_platform
cd "$ROOT"
sha256sum --check --quiet SHA256SUMS
if [ "$CHECK_ONLY" = 1 ]; then
  echo 'Platform and package checks passed. Nothing installed.'
  exit 0
fi
confirm_autonomy || exit 1
if [ "$(id -u)" -ne 0 ]; then
  echo 'Installing Better Bots requires administrator access.'
  exec sudo env BETTER_BOTS_ACCEPT_AUTONOMY=yes bash "$ROOT/install.sh" "$@"
fi
umask 077
export DEBIAN_FRONTEND=noninteractive
PACKAGES=(ca-certificates curl gnupg bubblewrap apparmor apparmor-utils poppler-utils xvfb x11vnc xdotool scrot
  fluxbox pcmanfm xterm dbus-x11 fonts-dejavu-core xdg-utils python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1)
[ "$WITH_HINDSIGHT" = 0 ] || PACKAGES+=(python3-venv python3-pip postgresql-16 postgresql-16-pgvector)
apt-get update
apt-get install -y "${PACKAGES[@]}"
if ! command -v node >/dev/null || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
  # Use the signed NodeSource repository, without executing a downloaded script.
  [ ! -e /etc/apt/keyrings/better-bots-nodesource.gpg ] || { echo 'Review existing NodeSource key before retrying.' >&2; exit 1; }
  [ ! -e /etc/apt/sources.list.d/better-bots-node.list ] || { echo 'Review existing NodeSource source before retrying.' >&2; exit 1; }
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/better-bots-nodesource.gpg
  chmod 644 /etc/apt/keyrings/better-bots-nodesource.gpg
  echo 'deb [signed-by=/etc/apt/keyrings/better-bots-nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/better-bots-node.list
  chmod 644 /etc/apt/sources.list.d/better-bots-node.list
  apt-get update
  apt-get install -y nodejs
fi
command -v npm >/dev/null || { echo 'The Node installation must include npm.' >&2; exit 1; }
# Mint supplies a native Firefox. Leave its policies and the user's profile alone.
command -v firefox >/dev/null || apt-get install -y firefox
if firefox --version 2>/dev/null | grep -qi snap; then echo 'A native Firefox package is required for the agent desktop.' >&2; exit 1; fi

useradd --system --home /var/lib/better-bots --shell /usr/sbin/nologin better-bots
install -d -o better-bots -g better-bots -m 0750 /var/lib/better-bots
install -d -m 0755 /opt/better-bots
cp -R "$ROOT/." /opt/better-bots/
chown -R root:root /opt/better-bots
chmod -R u=rwX,go=rX /opt/better-bots
# Dependencies install as the service account in a temporary build folder,
# never run npm package hooks as root.
BUILD_DIR=$(mktemp -d /var/tmp/better-bots-build.XXXXXX)
chown better-bots:better-bots "$BUILD_DIR"
install -o better-bots -g better-bots -m 0644 /opt/better-bots/package{,-lock}.json "$BUILD_DIR/"
(cd "$BUILD_DIR" && sudo -u better-bots env HOME=/var/lib/better-bots npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
mv "$BUILD_DIR/node_modules" /opt/better-bots/node_modules
chown -R root:root /opt/better-bots/node_modules
chmod -R u=rwX,go=rX /opt/better-bots/node_modules
rm "$BUILD_DIR/package.json" "$BUILD_DIR/package-lock.json"
rmdir "$BUILD_DIR"

# Keep the existing distro profile if provided. Never disable namespace
# restrictions system-wide; prove that the service account can use bwrap.
if [ ! -e /etc/apparmor.d/bwrap ]; then
  cat > /etc/apparmor.d/bwrap <<'AA'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
AA
  chmod 644 /etc/apparmor.d/bwrap
fi
apparmor_parser -r /etc/apparmor.d/bwrap
systemd-run --quiet --wait --pipe --property=User=better-bots --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ProtectHome=yes --property=PrivateTmp=yes /usr/bin/bwrap --ro-bind / / --unshare-user --unshare-pid --unshare-uts --unshare-ipc --unshare-net --proc /proc --dev /dev /usr/bin/true

install -m 644 /opt/better-bots/deploy/better-bots.service /etc/systemd/system/better-bots.service
BACKUP_ENV=BETTER_BOTS_BACKUP_DATABASE=none
if [ "$WITH_HINDSIGHT" = 1 ]; then
  install_hindsight
else
  # The shared unit requires a memory engine; with SQLite there is nothing extra to run.
  install -d -m 0755 /etc/systemd/system/better-bots.service.d
  printf '[Service]\n# Memory runs on the built-in SQLite store.\nEnvironment=BETTER_BOTS_REQUIRE_HINDSIGHT=0\n' \
    > /etc/systemd/system/better-bots.service.d/memory.conf
  chmod 644 /etc/systemd/system/better-bots.service.d/memory.conf
fi
systemctl daemon-reload
systemctl enable --now better-bots
READY=0
for _ in $(seq 1 30); do
  # /healthz is the token-free liveness route; everything under /api wants the console token.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:4173/healthz || true)
  if [ "$code" = 200 ] || [ "$code" = 503 ]; then READY=1; break; fi
  sleep 2
done
[ "$READY" -eq 1 ] || { echo 'App startup failed. Inspect: journalctl -u better-bots' >&2; exit 1; }
# The console always wants a token, kept where only the service can read it. The
# person who ran the installer gets their own copy of the login link.
LOGIN_SAVED=0
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && [ -s /var/lib/better-bots/console-token ]; then
  USER_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
  printf 'http://127.0.0.1:4173/#token=%s\n' "$(cat /var/lib/better-bots/console-token)" \
    | sudo -u "$SUDO_USER" sh -c 'umask 077; mkdir -p "$1" && cat > "$1/console-url"' _ "$USER_HOME/.config/better-bots" \
    && LOGIN_SAVED=1
fi
# The app opens in its own window, signed in with the saved login link.
cat > /usr/local/bin/better-bots-open <<'LAUNCH'
#!/bin/sh
exec /usr/bin/python3 -I /opt/better-bots/window.py "$@"
LAUNCH
chmod 755 /usr/local/bin/better-bots-open
# One backup command that already knows which memory store this install uses.
printf '#!/bin/sh\nexec env %s /opt/better-bots/deploy/backup.sh "$@"\n' "$BACKUP_ENV" > /usr/local/bin/better-bots-backup
chmod 755 /usr/local/bin/better-bots-backup
cat > /usr/share/applications/better-bots.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Better Bots
Comment=Create your own agents and workflows
Exec=/usr/local/bin/better-bots-open
Icon=/opt/better-bots/icon.png
StartupWMClass=better-bots
Terminal=false
Categories=Development;Utility;
DESKTOP
chmod 644 /usr/share/applications/better-bots.desktop
printf '\nInstalled. Open Better Bots from your application menu.\n'
[ "$LOGIN_SAVED" = 1 ] || printf 'Your login link: http://127.0.0.1:4173/#token=<the token in /var/lib/better-bots/console-token>\n'
printf 'Connect your models in App settings, then create your first agent.\n'
if [ "$WITH_HINDSIGHT" = 1 ]; then printf 'Memory: Hindsight on port %s.\n' "$HINDSIGHT_PORT"; else printf 'Memory: the built-in SQLite store.\n'; fi
printf 'Back up with: sudo better-bots-backup\n'
printf 'Startup checks passed; memory retention/recall and backup restore are not yet verified.\n'

}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
