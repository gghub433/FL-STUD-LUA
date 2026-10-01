#!/usr/bin/env bash
# Builds dist/LuaLoops.love and a ready-to-run Windows folder/zip:
#   dist/LuaLoops-win64/LuaLoops.exe (+ LÖVE runtime DLLs)
#   dist/LuaLoops-win64.zip
# Needs: bash, curl, zip, unzip, sha256sum. Works on Linux, macOS and Git Bash.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="LuaLoops"
LOVE_VERSION="11.5"
LOVE_SHA256="ba6e56be2685e53c817749c4a5007f51137136fe5a3ab64920508babc2e74369"
DIST="$ROOT/dist"
CACHE="${LOVE_CACHE:-$ROOT/.cache}"

mkdir -p "$DIST" "$CACHE"

echo "==> Packing $NAME.love"
rm -f "$DIST/$NAME.love"
(cd "$ROOT/src" && zip -9 -q -r "$DIST/$NAME.love" . -x '*.DS_Store')

echo "==> Fetching LÖVE $LOVE_VERSION runtime for Windows"
RUNTIME_ZIP="$CACHE/love-$LOVE_VERSION-win64.zip"
if [ ! -f "$RUNTIME_ZIP" ]; then
  curl -fsSL -o "$RUNTIME_ZIP.part" \
    "https://github.com/love2d/love/releases/download/$LOVE_VERSION/love-$LOVE_VERSION-win64.zip"
  mv "$RUNTIME_ZIP.part" "$RUNTIME_ZIP"
fi
echo "$LOVE_SHA256  $RUNTIME_ZIP" | sha256sum -c - >/dev/null || {
  echo "Checksum mismatch for $RUNTIME_ZIP" >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q "$RUNTIME_ZIP" -d "$TMP"
RT="$TMP/love-$LOVE_VERSION-win64"

echo "==> Fusing $NAME.exe"
OUT="$DIST/$NAME-win64"
rm -rf "$OUT"
mkdir -p "$OUT"
# A fused LÖVE game is love.exe with the .love archive appended.
cat "$RT/love.exe" "$DIST/$NAME.love" > "$OUT/$NAME.exe"
cp "$RT"/*.dll "$OUT/"
cp "$RT/license.txt" "$OUT/LOVE-runtime-license.txt"
cp "$ROOT/LICENSE" "$OUT/LICENSE.txt"
cat > "$OUT/README.txt" <<'EOF'
LuaLoops - free pattern-based beat maker (Windows 64-bit)

Run LuaLoops.exe. Keep the .dll files next to it.
Press Space to play the demo song, F1 for help.

Projects, exports (WAV) and the autosave live in:
  %APPDATA%\LuaLoops
(the "Folder" button in the app opens it).

Windows SmartScreen may warn because the exe is not code-signed:
click "More info" -> "Run anyway".

LuaLoops is free and open source (MIT). It runs on the LOVE 2D engine
(zlib license, see LOVE-runtime-license.txt). Not affiliated with Image-Line.
EOF

(cd "$DIST" && rm -f "$NAME-win64.zip" && zip -9 -q -r "$NAME-win64.zip" "$NAME-win64")
echo "==> Done:"
ls -la "$DIST"
