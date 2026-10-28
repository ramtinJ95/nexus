#!/usr/bin/env bash
# Runs stack.ts and drive.mjs against this checkout and saves the captures in branch/ here. Then it runs the live
# check's tests into tests.txt. MODULES names the node_modules that hold @sparticuz/chromium and puppeteer-core,
# LD_LIBRARY_PATH the libraries its Chromium needs, and FONTCONFIG_PATH the fonts.conf of the fonts it ships.
#
#   MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=... docs/verification/verify-pylon/run.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
dest="$here/branch"
log=$(mktemp)
stack=
trap '[ -n "$stack" ] && kill "$stack" 2>/dev/null; rm -f "$log"' EXIT
rm -rf "$dest" && mkdir -p "$dest"
cd "$repo"
npm run build >/dev/null
echo "branch: $(git log --oneline -1)$(git diff --quiet HEAD -- src || echo ', with uncommitted changes under src/')" | tee "$dest/commit.txt"
OUT="$dest" node docs/verification/verify-pylon/stack.ts > "$log" 2>&1 &
stack=$!
until grep -q '^{' "$log"; do kill -0 "$stack" || { cat "$log"; exit 1; }; sleep 0.5; done
OUT="$dest" ROOT="$repo" node "$here/drive.mjs"
kill "$stack"; wait "$stack" || true
stack=
node --test --test-name-pattern="live check|verify pylon|nested virtualization|nests KVM|has a file" src/control/review.test.ts src/control/gate.test.ts src/control/api.test.ts src/control/dashboard.test.ts src/cli/nexus.test.ts src/probe/server.test.ts src/pylon-vm-backend.test.ts src/control/pr-watch.test.ts > "$dest/tests.txt" 2>&1 || true
