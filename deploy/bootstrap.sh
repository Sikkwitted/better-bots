#!/usr/bin/env bash
#
# Provision a fresh Ubuntu 24.04 box to run better-bots. Idempotent — safe to re-run.
#
#   sudo bash /opt/better-bots/deploy/bootstrap.sh
#
# It expects the code at /opt/better-bots (git clone it there first). It never
# writes secrets: the environment file, /var/lib/better-bots/better-bots.env, is
# created with no secrets in it for you to fill in.

set -euo pipefail

APP_DIR=/opt/better-bots
DATA_DIR=/var/lib/better-bots
# Inside the state dir on purpose: the unit sets ProtectSystem=strict, so /etc is
# read-only to the service and the console could not save a key there. Keeping it
# here means credentials stay writable without opening /etc back up.
ENV_FILE=$DATA_DIR/better-bots.env
SERVICE_USER=better-bots

[ "$(id -u)" -eq 0 ] || { echo "run this with sudo" >&2; exit 1; }
[ -f "$APP_DIR/src/server.js" ] || { echo "no host found at $APP_DIR — git clone the code there first" >&2; exit 1; }

echo "==> Node 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
node --version

echo "==> PDF text reader"
apt-get install -y -qq poppler-utils >/dev/null

echo "==> service user and store"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR"
chown -R root:root "$APP_DIR"

echo "==> the shared sandbox computer's monitors"
# This box is the shared sandbox computer, not one machine per agent. A monitor is
# an X display with its own loopback VNC endpoint; agents drive it with xdotool.
# Firefox comes from Mozilla's apt repository because Ubuntu's own package is a
# snap, and snaps do not run under the hardened service unit.
if [ "${BETTER_BOTS_DESKTOP:-xvfb}" = "xvfb" ]; then
  apt-get install -y -qq xvfb x11vnc xdotool scrot fluxbox pcmanfm xterm dbus-x11 fonts-dejavu-core >/dev/null
  if ! command -v firefox >/dev/null 2>&1 || firefox --version 2>/dev/null | grep -qi snap; then
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/packages.mozilla.org.asc
    echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" \
      > /etc/apt/sources.list.d/mozilla.list
    printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla
    apt-get update -qq
    apt-get install -y -qq firefox >/dev/null
  fi
  # An agent's browser must open on the page it was asked for, not on a
  # first-run dialog. Enterprise policy is the supported way to say so.
  install -d -m 0755 /etc/firefox/policies
  cat > /etc/firefox/policies/policies.json <<'POLEOF'
{
  "policies": {
    "SkipTermsOfUse": true,
    "OverrideFirstRunPage": "",
    "OverridePostUpdatePage": "",
    "DisableTelemetry": true,
    "DisableFirefoxStudies": true,
    "DisableAppUpdate": true,
    "DontCheckDefaultBrowser": true,
    "NoDefaultBookmarks": true,
    "DisablePocket": true,
    "UserMessaging": { "SkipOnboarding": true, "ExtensionRecommendations": false, "FeatureRecommendations": false, "MoreFromMozilla": false },
    "Homepage": { "StartPage": "none" }
  }
}
POLEOF
  echo "   Xvfb, x11vnc, xdotool, scrot, fluxbox, firefox: $(firefox --version 2>/dev/null || echo firefox missing)"
else
  echo "   skipped (BETTER_BOTS_DESKTOP=$BETTER_BOTS_DESKTOP); screens will be bookkeeping only"
fi

echo "==> the agent shell's container"
# Every SandboxRunCommand runs inside bubblewrap namespaces: the agent sees /usr
# and /etc, its own directory read-write, the workspace read-only, and nothing
# else — no state directory, no credentials, no other agent's files. Ubuntu
# restricts unprivileged user namespaces by default; this AppArmor profile grants
# them to bwrap alone rather than turning the restriction off for the whole box.
apt-get install -y -qq bubblewrap >/dev/null
cat > /etc/apparmor.d/bwrap <<'AAEOF'
# Allow bubblewrap to create user namespaces; Ubuntu restricts them by default.
# This is the per-command sandbox the better-bots agent shell runs inside.
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
AAEOF
apparmor_parser -r /etc/apparmor.d/bwrap 2>/dev/null && echo "   bubblewrap $(bwrap --version | awk '{print $2}') with user namespaces permitted" || echo "   WARNING: AppArmor profile failed to load; the shell will fall back to process containment"

echo "==> the ChatGPT subscription sign-in tool"
# Optional provider: a ChatGPT Plus/Pro plan, signed in once as the service user
# with the official Codex CLI. The host reads and refreshes its auth.json; the
# refresh token rotates, so this box must be the only place that file lives.
if ! command -v codex >/dev/null 2>&1; then npm install -g @openai/codex --silent >/dev/null 2>&1 || echo "   codex CLI install failed (optional)"; fi
command -v codex >/dev/null 2>&1 && echo "   codex $(codex --version 2>/dev/null | head -1); connect ChatGPT from Better Bots App settings → AI providers"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_DIR/.codex"

echo "==> uv, for plugins that run here (stdio MCP servers launched with uvx)"
# Installed for the service user, whose HOME is the data dir, so uvx and its
# cache live where the host runs. The MCP client passes PATH and HOME through.
if ! sudo -u "$SERVICE_USER" HOME="$DATA_DIR" sh -c 'command -v uvx || test -x "$HOME/.local/bin/uvx"' >/dev/null 2>&1; then
  sudo -u "$SERVICE_USER" HOME="$DATA_DIR" sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh -s -- --quiet' >/dev/null 2>&1 || echo "   uv install failed (optional; uvx plugins need it)"
fi
sudo -u "$SERVICE_USER" HOME="$DATA_DIR" sh -c 'test -x "$HOME/.local/bin/uvx"' 2>/dev/null && echo "   uvx at $DATA_DIR/.local/bin/uvx"

echo "==> locked runtime dependencies"
( cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent )

# Older installs kept it in /etc; move it rather than losing the keys.
if [ -f /etc/better-bots.env ] && [ ! -f "$ENV_FILE" ]; then
  mv /etc/better-bots.env "$ENV_FILE"
  echo "==> migrated /etc/better-bots.env -> $ENV_FILE"
fi

echo "==> $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENVEOF'
# Secrets for better-bots. This file is read by systemd, not by git.
# ANTHROPIC_API_KEY=sk-ant-...
# Only needed if you publish the console beyond loopback:
# BETTER_BOTS_TOKEN=
ENVEOF
  echo "   created — put your API key in it"
else
  echo "   already exists, left alone"
fi
# How a person reaches a monitor from their own machine, shown in OpenScreen
# results. Per machine, so it lives in the env file rather than the shared unit.
if ! grep -q '^BETTER_BOTS_SSH_TARGET=' "$ENV_FILE"; then
  echo "BETTER_BOTS_SSH_TARGET=${SUDO_USER:-root}@$(hostname -I 2>/dev/null | awk '{print $1}')" >> "$ENV_FILE"
fi
# Readable by the service user (which spends the key anyway), not by anyone else.
chown "$SERVICE_USER":"$SERVICE_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "==> proving it runs before enabling it"
if ! TEST_OUT=$(cd "$APP_DIR" && sudo -u "$SERVICE_USER" node --test 'test/*.test.js' 2>&1); then
  echo "$TEST_OUT" | grep -E "^not ok|^# (pass|fail)" >&2
  echo "tests failed as $SERVICE_USER; not deploying" >&2
  exit 1
fi
echo "$TEST_OUT" | grep -E "^# (tests|pass|fail)" | tr '\n' ' '; echo

echo "==> better-bots command"
# Without this, running the CLI from a shell points at ./.data — a different,
# empty store from the one the service uses. It fails silently, which is worse
# than failing loudly: you see an empty roster and assume nothing is running.
#
# Two files on purpose. The helper is root-owned and sets BETTER_BOTS_DIR itself, so
# the sudoers rule below can name one exact script and permit no environment.
# Passing BETTER_BOTS_DIR through sudo instead would mean allowing SETENV on node,
# which is a NODE_OPTIONS code-injection hole wearing a convenience hat.
install -d -m 755 /usr/local/lib
cat > /usr/local/lib/better-bots-cli <<HELPEOF
#!/usr/bin/env bash
# systemd hands the service its EnvironmentFile; the CLI is a separate process
# and would otherwise have no credentials at all — the console would think for
# real while \`better-bots ask\` insisted no provider was configured.
set -a
[ -r $ENV_FILE ] && . $ENV_FILE
set +a
export BETTER_BOTS_DIR=$DATA_DIR
exec /usr/bin/node $APP_DIR/src/cli.js "\$@"
HELPEOF
chown root:root /usr/local/lib/better-bots-cli
chmod 755 /usr/local/lib/better-bots-cli

cat > /usr/local/bin/better-bots <<WRAPEOF
#!/usr/bin/env bash
# Talks to the running host's store, from any directory, as the service user.
exec sudo -u $SERVICE_USER /usr/local/lib/better-bots-cli "\$@"
WRAPEOF
chmod 755 /usr/local/bin/better-bots

# The wrapper runs the CLI as the service user. Read-only commands (status,
# audit, explain, doctor) run without a password, so checking in from a phone
# stays quick. Everything else asks for it: commands like `connect --command`
# start programs as the service user, which holds every key, and any program
# running as you could otherwise do that silently. Sudo applies the last
# matching line, so the passwordless one comes last.
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  echo "==> sudoers rule for $SUDO_USER"
  RULE="/etc/sudoers.d/better-bots"
  CLI=/usr/local/lib/better-bots-cli
  {
    printf '%s ALL=(%s) %s\n' "$SUDO_USER" "$SERVICE_USER" "$CLI"
    printf '%s ALL=(%s) NOPASSWD: %s status, %s audit, %s audit *, %s explain *, %s doctor\n' "$SUDO_USER" "$SERVICE_USER" "$CLI" "$CLI" "$CLI" "$CLI" "$CLI"
  } > "$RULE.tmp"
  # A malformed sudoers file breaks sudo entirely, so validate before installing.
  if visudo -cf "$RULE.tmp" >/dev/null 2>&1; then
    install -m 440 -o root -g root "$RULE.tmp" "$RULE"
    echo "   $SUDO_USER can check status without a password; other commands ask for it"
  else
    echo "   WARNING: generated sudoers rule failed validation; skipped"
  fi
  rm -f "$RULE.tmp"
fi

echo "==> nightly backup"
# Everything the agents know, once a night, fourteen days deep. Restoring is a
# tar back into /var/lib and (if the memory engine is installed) a pg_restore.
cat > /etc/systemd/system/better-bots-backup.service <<'BKEOF'
[Unit]
Description=Back up the better-bots store and memory database
[Service]
Type=oneshot
ExecStart=/opt/better-bots/deploy/backup.sh
BKEOF
cat > /etc/systemd/system/better-bots-backup.timer <<'BKEOF'
[Unit]
Description=Nightly better-bots backup
[Timer]
OnCalendar=*-*-* 04:10:00 UTC
Persistent=true
RandomizedDelaySec=10m
[Install]
WantedBy=timers.target
BKEOF
chmod 755 "$APP_DIR/deploy/backup.sh"
systemctl daemon-reload
systemctl enable --now better-bots-backup.timer >/dev/null 2>&1
echo "   $(systemctl list-timers better-bots-backup.timer --no-pager | sed -n 2p | awk '{print $1, $2, $3}')"

echo "==> journal log size cap"
install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/better-bots-storage.conf <<'JEOF'
[Journal]
SystemMaxUse=250M
JEOF
systemctl restart systemd-journald 2>/dev/null || true

echo "==> service"
cp "$APP_DIR/deploy/better-bots.service" /etc/systemd/system/better-bots.service
if [ -d /etc/needrestart/conf.d ]; then
  install -m 644 -o root -g root "$APP_DIR/deploy/needrestart-better-bots.conf" /etc/needrestart/conf.d/better-bots.conf
fi
systemctl daemon-reload
systemctl enable better-bots
# restart, not just start: enable --now leaves an already-running service on the
# old code, so re-provisioning would silently deploy nothing.
systemctl restart better-bots
sleep 2
systemctl is-active --quiet better-bots && echo "   running" || { journalctl -u better-bots -n 20 --no-pager; exit 1; }

cat <<'DONE'

Done. It is bound to 127.0.0.1, so nothing is exposed yet.

  Reach it:   ssh -N -L 4173:127.0.0.1:4173 <user>@<host>
              then open http://127.0.0.1:4173

  Logs:       journalctl -u better-bots -f
  Restart:    systemctl restart better-bots

Replies are a scripted stand-in until a provider key is set — either in the
console (Providers panel) or in $ENV_FILE followed by: systemctl restart better-bots
DONE
