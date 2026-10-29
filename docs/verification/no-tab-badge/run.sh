#!/usr/bin/env bash
# Runs ../dashboard-scrolling/stack.ts and drive.mjs on main and on this branch, each from its own worktree with this
# directory's driver, and saves each run's tab.json and tab.png in main/ and branch/ here. MODULES names the
# node_modules that hold @sparticuz/chromium and puppeteer-core, LD_LIBRARY_PATH the libraries its Chromium needs, and
# FONTCONFIG_PATH its fonts.
#
#   MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=... docs/verification/no-tab-badge/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
stack=
trap '[ -z "$stack" ] || kill "$stack" 2>/dev/null || true; for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  rm -rf "${here:?}/$run"
  mkdir -p "$here/$run"
  cp "$repo/docs/verification/dashboard-scrolling/stack.ts" "$tree/docs/verification/dashboard-scrolling/"
  (cd "$tree" && npm run build >/dev/null)
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && EVIDENCE="$work/$run-evidence" exec node docs/verification/dashboard-scrolling/stack.ts) >"$work/$run-stack.out" 2>&1 &
  stack=$!
  until grep -q '^{' "$work/$run-stack.out"; do kill -0 "$stack" || { cat "$work/$run-stack.out"; exit 1; }; sleep 0.5; done
  OUT="$here/$run" STACK=$(grep '^{' "$work/$run-stack.out") node "$here/drive.mjs"
  kill "$stack"; wait "$stack" || true
  stack=
done
