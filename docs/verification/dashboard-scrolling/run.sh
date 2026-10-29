#!/usr/bin/env bash
# Runs stack.ts and drive.mjs on main and on this branch, each from its own worktree with this directory's copies of
# both files, and saves each run's captures in main/ and branch/ here. MODULES names the node_modules that hold
# @sparticuz/chromium and puppeteer-core, LD_LIBRARY_PATH the libraries its Chromium needs, and FONTCONFIG_PATH its
# fonts. RUNS picks the runs, both by default.
#
#   MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=... docs/verification/dashboard-scrolling/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
stack=
trap '[ -z "$stack" ] || kill "$stack" 2>/dev/null || true; for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT

for run in ${RUNS:-main branch}; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  rm -rf "${here:?}/$run"
  mkdir -p "$tree/docs/verification/dashboard-scrolling" "$here/$run"
  cp "$here/stack.ts" "$here/drive.mjs" "$tree/docs/verification/dashboard-scrolling/"
  (cd "$tree" && npm run build >/dev/null)
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && EVIDENCE="$here/$run" exec node docs/verification/dashboard-scrolling/stack.ts) >"$here/$run/stack.out" 2>&1 &
  stack=$!
  until grep -q '^{' "$here/$run/stack.out"; do kill -0 "$stack" || { cat "$here/$run/stack.out"; exit 1; }; sleep 0.5; done
  OUT="$here/$run" STACK=$(grep '^{' "$here/$run/stack.out") node "$here/drive.mjs"
  kill "$stack"; wait "$stack" || true
  stack=
done
