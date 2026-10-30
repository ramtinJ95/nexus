#!/usr/bin/env bash
# Runs stack.ts, land-button-waives/stack.ts with absent live checks, from this checkout and drives it with drive.mjs over the API and the dashboard,
# with no browser, saving the captures beside this script.
#
#   docs/verification/hold-codes/run.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
cd "$repo"
npm run build >/dev/null
git log --oneline -1 > "$here/commit.txt"
evidence=$(mktemp -d)
EVIDENCE="$evidence" node docs/verification/hold-codes/stack.ts > "$evidence/stack.out" 2>&1 &
stack=$!
trap 'kill "$stack" 2>/dev/null || true; rm -rf "$evidence"' EXIT
until grep -q '^{' "$evidence/stack.out"; do kill -0 "$stack" || { cat "$evidence/stack.out"; exit 1; }; sleep 0.5; done
OUT="$here" STACK=$(grep '^{' "$evidence/stack.out") node "$here/drive.mjs"
cp "$evidence/github.log" "$here/github.log"
