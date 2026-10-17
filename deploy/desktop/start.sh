#!/bin/sh
set -eu
mkdir -p /home/agent/profile
cat > /home/agent/profile/user.js <<'EOF'
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
EOF
Xvfb :10 -screen 0 1280x800x24 -nolisten tcp -ac &
for attempt in $(seq 1 50); do
  xdotool getdisplaygeometry >/dev/null 2>&1 && break
  sleep 0.1
done
xdotool getdisplaygeometry >/dev/null
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :10 -rfbport 5900 -forever -shared -nopw -quiet -noxdamage >/tmp/vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
wait
