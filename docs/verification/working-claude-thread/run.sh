#!/usr/bin/env bash
# Runs capture.ts against main and against this checkout, into main/ and branch/ next to this script.
# Needs Node 24 or newer, npm ci done in this checkout, local port 7471 free, and the npm registry. The browser is
# @sparticuz/chromium's headless Chromium with the shared libraries it ships, so it runs on a machine with no
# browser and no system libraries for one, such as a Nexus pylon.
#
#   docs/verification/working-claude-thread/run.sh [base]    # base defaults to origin/main
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
base=${1:-origin/main}
work=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$work/main" 2>/dev/null || true; rm -rf "$work"' EXIT

npm install --prefix "$work/deps" --no-save --no-audit --no-fund \
  playwright-core@1.54.2 @sparticuz/chromium@138.0.2 @xterm/xterm@5.5.0 dejavu-fonts-ttf@2.37.3 >/dev/null
bin="$work/deps/node_modules/@sparticuz/chromium/bin"
unbrotli() { node -e 'process.stdout.write(require("zlib").brotliDecompressSync(require("fs").readFileSync(process.argv[1])))' "$1"; }
mkdir -p "$work/chrome" "$work/fonts"
unbrotli "$bin/chromium.br" > "$work/chrome/chromium" && chmod +x "$work/chrome/chromium"
unbrotli "$bin/al2023.tar.br" | tar x -C "$work/chrome"
unbrotli "$bin/swiftshader.tar.br" | tar x -C "$work/chrome"
cp "$work/deps/node_modules/dejavu-fonts-ttf/ttf/"DejaVuSans*.ttf "$work/fonts/"
cat > "$work/fonts/fonts.conf" <<EOF
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>$work/fonts</dir><cachedir>$work/fonts/cache</cachedir></fontconfig>
EOF
export BROWSER_DEPS="$work/deps" CHROMIUM="$work/chrome/chromium" FONTCONFIG_FILE="$work/fonts/fonts.conf"
export LD_LIBRARY_PATH="$work/chrome/lib:$work/chrome${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

git -C "$repo" worktree add --detach "$work/main" "$base" >/dev/null
ln -s "$repo/node_modules" "$work/main/node_modules"
(cd "$work/main" && npm run build >/dev/null)
(cd "$repo" && npm run build >/dev/null)

rm -rf "$here/main" "$here/branch"
node "$here/capture.ts" "$work/main" "$here/main" "main at $(git -C "$repo" rev-parse --short "$base")"
node "$here/capture.ts" "$repo" "$here/branch" "fix/issue-127-working-claude-thread at $(git -C "$repo" rev-parse --short HEAD)"
