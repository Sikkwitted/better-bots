#!/usr/bin/env bash
#
# Build "Better Bots.app" for this Mac: an icon made from one of the bots' own
# faces around the native shell in tools/BetterBots.swift — a window of its own
# for the console, with the SSH tunnel when the host is on a server.
#
#   tools/make-app.sh                 -> ~/Applications/Better Bots.app
#   tools/make-app.sh /Applications   -> there instead
#   FACE=avatar-square-crown-51FFCD tools/make-app.sh   (any face in web/avatars)
#   FACE=~/Desktop/face.png tools/make-app.sh               (or any PNG by path)
#   ICON=~/Desktop/icon.png tools/make-app.sh   a finished 1024px icon instead of a face:
#       used as is when its corners are already transparent, masked to the
#       macOS rounded square when it is a full-bleed image
#   BB_URL=http://127.0.0.1:4173 BB_SSH=user@server tools/make-app.sh
#       seeds the app's config so the first launch connects without asking
#       BB_TOKEN=... seeds the console token too; without it and without BB_SSH,
#       the token of a host on this Mac is read from ${BETTER_BOTS_DIR:-./.data}
#
# The default is the finished icon checked in at tools/app/icon.png.
# Nothing here touches the server. Needs the Xcode command line tools (swiftc).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")"
DEST="${1:-$HOME/Applications}"
FACE="${FACE:-}"
ICON="${ICON:-}"
# Unless a face was asked for, the finished icon in the repo is the icon. It
# ships prebuilt as tools/app/BetterBots.icns, so the default build needs no
# Python imaging; FACE or ICON builds a new one with Pillow.
PREBUILT=""
[ -z "$ICON" ] && [ -z "$FACE" ] && [ -f "$ROOT/tools/app/BetterBots.icns" ] && PREBUILT="$ROOT/tools/app/BetterBots.icns"
[ -z "$ICON" ] && [ -z "$FACE" ] && ICON="$ROOT/tools/app/icon.png"
APP="$DEST/Better Bots.app"
BUILD="$(mktemp -d)"

command -v swiftc >/dev/null || { echo "swiftc not found: xcode-select --install" >&2; exit 1; }
if [ -n "$PREBUILT" ]; then
  echo "==> icon from $PREBUILT"
  cp "$PREBUILT" "$BUILD/BetterBots.icns"
else
command -v iconutil >/dev/null || { echo "iconutil not found: this builds a macOS app" >&2; exit 1; }
python3 -c "import PIL" 2>/dev/null || { echo "Pillow is needed: python3 -m pip install pillow" >&2; exit 1; }
if [ -n "$ICON" ]; then
  [ -f "$ICON" ] || { echo "no icon at $ICON" >&2; exit 1; }
  SRC_PATH="$ICON"; MODE=icon
else
  if [ -f "$FACE" ]; then SRC_PATH="$FACE"; else SRC_PATH="$ROOT/web/avatars/$FACE.png"; fi
  [ -f "$SRC_PATH" ] || { echo "no face at $FACE (a PNG path, or a name in web/avatars)" >&2; exit 1; }
  MODE=face
fi

echo "==> icon from $SRC_PATH"
mkdir -p "$BUILD/icon.iconset"
python3 - "$MODE" "$SRC_PATH" "$BUILD/icon.iconset" <<'PY'
import sys
from PIL import Image, ImageDraw
mode, src_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
src = Image.open(src_path).convert("RGBA")

if mode == "icon":
    # A finished icon. Full-bleed art (opaque corners) is masked to the system's
    # rounded square inside its margin; art with clear corners is already shaped.
    side = max(src.size)
    art = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    art.alpha_composite(src, ((side - src.width) // 2, (side - src.height) // 2))
    if art.getpixel((2, 2))[3] > 8:
        pad = round(side * 0.06)
        inner = art.resize((side - 2 * pad, side - 2 * pad), Image.LANCZOS)
        mask = Image.new("L", inner.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, inner.width - 1, inner.height - 1], radius=round(side * 0.22), fill=255)
        shaped = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        shaped.paste(inner, (pad, pad), mask)
        art = shaped
    def tile(size):
        return art.resize((size, size), Image.LANCZOS)
else:
    face = src.crop(src.getbbox())            # trim the render's own margin
    side = max(face.size)                     # square it, centred, so it fits the tile evenly
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.alpha_composite(face, ((side - face.width) // 2, (side - face.height) // 2))
    face = sq

    def tile(size):
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        pad = round(size * 0.06)          # macOS icons sit inside a margin
        r = round(size * 0.22)            # the squircle-ish corner the system uses
        d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=r, fill=(18, 18, 18, 255))
        # A violet accent along the bottom, the console's one colour.
        band = round(size * 0.055)
        d.rounded_rectangle([pad, size - pad - band * 2, size - pad, size - pad], radius=r, fill=(109, 40, 217, 255))
        d.rectangle([pad, size - pad - band * 2, size - pad, size - pad - band], fill=(18, 18, 18, 255))
        f = face.resize((round(size * 0.74), round(size * 0.74)), Image.LANCZOS)
        img.alpha_composite(f, (round((size - f.width) / 2), round((size - f.height) / 2 - size * 0.03)))
        return img

for px, names in [(16, ["16x16"]), (32, ["16x16@2x", "32x32"]), (64, ["32x32@2x"]), (128, ["128x128"]),
                  (256, ["128x128@2x", "256x256"]), (512, ["256x256@2x", "512x512"]), (1024, ["512x512@2x"])]:
    img = tile(px)
    for n in names:
        img.save(f"{out}/icon_{n}.png")
PY
iconutil -c icns "$BUILD/icon.iconset" -o "$BUILD/BetterBots.icns"
fi

echo "==> shell"
# Universal when both targets build; the machine's own architecture otherwise.
SWIFT_SRC="$ROOT/tools/BetterBots.swift"
if swiftc -O -target arm64-apple-macos12.0 -o "$BUILD/bb-arm64" "$SWIFT_SRC" 2>/dev/null \
   && swiftc -O -target x86_64-apple-macos12.0 -o "$BUILD/bb-x86_64" "$SWIFT_SRC" 2>/dev/null; then
  lipo -create "$BUILD/bb-arm64" "$BUILD/bb-x86_64" -output "$BUILD/better-bots"
else
  echo "    universal build unavailable; building for $(uname -m) only" >&2
  swiftc -O -target "$(uname -m)-apple-macos12.0" -o "$BUILD/better-bots" "$SWIFT_SRC"
fi

echo "==> bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/BetterBots.icns" "$APP/Contents/Resources/BetterBots.icns"
cp "$BUILD/better-bots" "$APP/Contents/MacOS/better-bots"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Better Bots</string>
  <key>CFBundleDisplayName</key><string>Better Bots</string>
  <key>CFBundleIdentifier</key><string>dev.betterbots.launcher</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>better-bots</string>
  <key>CFBundleIconFile</key><string>BetterBots</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict>
    <!-- Hosts are reached over http on loopback or a LAN; there is no TLS to require. -->
    <key>NSAllowsArbitraryLoads</key><true/>
  </dict>
</dict></plist>
PLIST
# Ad hoc signature: enough for this Mac to run it. A Developer ID would let
# other Macs open it without the right-click; that is a release step, not a build one.
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "warning: codesign failed; the app may still run" >&2

# Optional seed so the first launch connects without the host dialog.
if [ -n "${BB_URL:-}" ]; then
  CFG="$HOME/Library/Application Support/Better Bots/config.json"
  if [ ! -f "$CFG" ]; then
    mkdir -p "$(dirname "$CFG")"
    TOKEN_FILE="${BETTER_BOTS_DIR:-$ROOT/.data}/console-token"
    if [ -z "${BB_TOKEN:-}" ] && [ -z "${BB_SSH:-}" ] && [ -r "$TOKEN_FILE" ]; then BB_TOKEN="$(cat "$TOKEN_FILE")"; fi
    # Mode 600 from the start: the config can carry the console token.
    BB_TOKEN="${BB_TOKEN:-}" python3 -c 'import json,os,sys; json.dump({k:v for k,v in {"url":sys.argv[1],"ssh":os.environ.get("BB_SSH") or None,"token":os.environ.get("BB_TOKEN") or None}.items() if v}, os.fdopen(os.open(sys.argv[2],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),"w"), indent=2)' "$BB_URL" "$CFG"
    echo "seeded $CFG"
  fi
fi
touch "$APP"   # nudge Finder to pick up the icon
# Finder and the Dock cache icons by path; a rebuilt bundle at the same path
# keeps the old picture until they are told otherwise.
/usr/bin/touch "$APP/Contents/Info.plist"
killall Finder Dock 2>/dev/null || true
rm -rf "$BUILD"

echo "built: $APP"
echo "Double-click it, or drag it to the Dock. First launch asks for the host; ⌘, changes it."
