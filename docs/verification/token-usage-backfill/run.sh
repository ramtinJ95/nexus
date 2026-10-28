#!/usr/bin/env bash
# Runs drive.mjs on main and on this branch, each from its own worktree with this directory's copies of probe.ts,
# control.ts and drive.mjs, and saves each run's captures in main/ and branch/ here. MODULES names the node_modules that
# hold @sparticuz/chromium and puppeteer-core, LD_LIBRARY_PATH the libraries its Chromium needs, and FONTCONFIG_PATH its
# fonts. RUNS picks the runs, both by default.
#
#   MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=... docs/verification/token-usage-backfill/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
# A socket path must fit in 108 bytes, so the fake tailscaleds listen in a short directory.
sockets=$(mktemp -d /tmp/nxb-XXXX)
trap 'for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work" "$sockets"' EXIT

for run in ${RUNS:-main branch}; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  rm -rf "$here/$run"
  mkdir -p "$tree/docs/verification/token-usage-backfill" "$here/$run" "$work/$run-state"
  cp "$here/probe.ts" "$here/control.ts" "$here/drive.mjs" "$tree/docs/verification/token-usage-backfill/"
  (cd "$tree" && npm run build >/dev/null)
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && ROOT="$tree" OUT="$here/$run" WORK="$work/$run-state" SOCKETS="$sockets" node docs/verification/token-usage-backfill/drive.mjs > "$here/$run/drive.out" 2>&1)
done
