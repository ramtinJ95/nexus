#!/usr/bin/env bash
# Runs stack.ts and drive.mjs on a commit, the branch's head by default, from its own worktree with this directory's
# copies of both files, and saves the captures in captures/ here. MODULES names the node_modules that hold
# @sparticuz/chromium and puppeteer-core, LD_LIBRARY_PATH the libraries its Chromium needs, and FONTCONFIG_PATH its
# fonts.
#
#   MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=... docs/verification/dashboard-themes/run.sh [commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
tree="$work/tree"
stack=
trap '[ -z "$stack" ] || kill "$stack" 2>/dev/null || true; git -C "$repo" worktree remove --force "$tree" 2>/dev/null || true; rm -rf "$work"' EXIT

git -C "$repo" worktree add --detach "$tree" "${1:-HEAD}" >/dev/null
ln -s "$repo/node_modules" "$tree/node_modules"
rm -rf "$here/captures"
mkdir -p "$tree/docs/verification/dashboard-themes" "$here/captures"
cp "$here/stack.ts" "$here/drive.mjs" "$tree/docs/verification/dashboard-themes/"
(cd "$tree" && npm run build >/dev/null)
git -C "$tree" log --oneline -1 | tee "$here/captures/commit.txt"
(cd "$tree" && EVIDENCE="$here/captures" exec node docs/verification/dashboard-themes/stack.ts) >"$here/captures/stack.out" 2>&1 &
stack=$!
until grep -q '^{' "$here/captures/stack.out"; do kill -0 "$stack" || { cat "$here/captures/stack.out"; exit 1; }; sleep 0.5; done
OUT="$here/captures" STACK=$(grep '^{' "$here/captures/stack.out") node "$here/drive.mjs"
