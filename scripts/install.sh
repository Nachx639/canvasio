#!/usr/bin/env bash
#
# CanvasIO one-line installer (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/Nachx639/canvasio/main/scripts/install.sh | bash
#
# Downloads the latest published release .dmg, mounts it, copies CanvasIO.app into
# /Applications and cleans up. No dependencies beyond what ships with macOS.

set -euo pipefail

REPO="Nachx639/canvasio"
APP="CanvasIO"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "CanvasIO is macOS-only. Aborting." >&2
  exit 1
fi

echo "==> Looking up the latest $APP release…"
DMG_URL="$(
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -o 'https://[^"]*\.dmg' \
    | head -n1
)"

if [[ -z "${DMG_URL:-}" ]]; then
  echo "Could not find a .dmg in the latest release. Open https://github.com/$REPO/releases" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DMG="$TMP/$APP.dmg"

echo "==> Downloading $DMG_URL"
curl -fSL "$DMG_URL" -o "$DMG"

echo "==> Mounting…"
MOUNT="$(hdiutil attach "$DMG" -nobrowse -readonly | tail -n1 | sed 's/.*\(\/Volumes\/.*\)/\1/')"

echo "==> Installing to /Applications…"
rm -rf "/Applications/$APP.app"
cp -R "$MOUNT/$APP.app" /Applications/

echo "==> Unmounting…"
hdiutil detach "$MOUNT" -quiet || true

# Clear the quarantine flag so Gatekeeper doesn't block an ad-hoc / first launch.
xattr -dr com.apple.quarantine "/Applications/$APP.app" 2>/dev/null || true

echo "==> Done. Launch it with:  open -a $APP"
