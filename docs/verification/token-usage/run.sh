#!/usr/bin/env bash
# Runs stack.ts and drive.mjs on main and on this branch, each from its own worktree with this directory's copies of
# both files, and saves each run's captures in main/ and branch/ here. Each run starts the stack, drives phase 1, stops
# the stack, starts it again on the same registry and harness storage, and drives phase 2. MODULES names the
# node_modules that hold @sparticuz/chromium and puppeteer-core, LD_LIBRARY_PATH the libraries its Chromium needs, and
# FONTCONFIG_PATH its fonts. RUNS picks the runs, both by default.
#
#   MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=... docs/verification/token-usage/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
stack=
trap '[ -z "$stack" ] || kill "$stack" 2>/dev/null || true; for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT

start() {
  (cd "$tree" && WORK="$work/$run-state" EVIDENCE="$here/$run" FIXTURES="$repo/src/fixtures" exec node docs/verification/token-usage/stack.ts) > "$here/$run/stack-$1.out" 2>&1 &
  stack=$!
  until grep -q '^{' "$here/$run/stack-$1.out"; do kill -0 "$stack" || { cat "$here/$run/stack-$1.out"; exit 1; }; sleep 0.5; done
}
stop() { kill "$stack"; wait "$stack" || true; stack=; }

for run in ${RUNS:-main branch}; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  rm -rf "$here/$run"
  mkdir -p "$tree/docs/verification/token-usage" "$here/$run"
  cp "$here/stack.ts" "$here/drive.mjs" "$tree/docs/verification/token-usage/"
  (cd "$tree" && npm run build >/dev/null)
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  for phase in 1 2; do
    start "$phase"
    OUT="$here/$run" ROOT="$tree" PHASE=$phase STACK=$(grep '^{' "$here/$run/stack-$phase.out") node "$here/drive.mjs"
    stop
  done
done
