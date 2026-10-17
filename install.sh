#!/usr/bin/env bash
# Install Better Bots as an app on this computer: one command, from the top of
# a checkout. macOS and Linux (Mint 22, Ubuntu 24.04).
#
#   ./install.sh
#
# macOS: deploy/macos/install.sh. Linux: packages this checkout exactly as a
# release and runs that package's installer (deploy/linux/install.sh), which
# asks for your administrator password. Extra arguments go to that installer.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -s)" in
  Darwin)
    exec bash "$ROOT/deploy/macos/install.sh" "$@" ;;
  Linux)
    command -v python3 >/dev/null || { echo "python3 is needed: sudo apt install python3" >&2; exit 1; }
    (cd "$ROOT" && python3 -c "import importlib.util as u; s = u.spec_from_file_location('release', 'tools/build-linux-release.py'); m = u.module_from_spec(s); s.loader.exec_module(m); m.export(archives=False)")
    exec bash "$ROOT/artifacts/linux-release/better-bots-mint-22-alpha/install.sh" "$@" ;;
  *)
    echo "Better Bots installs on macOS and Linux. Windows is not supported yet." >&2
    exit 1 ;;
esac
