#!/usr/bin/env bash
# Runs drive.ts and bench.ts on main and on this branch, each from its own worktree with this directory's copies of the
# scripts, and saves each run's result.json, screenshots and timings in main/ and branch/ here. MODULES names the
# node_modules that hold @sparticuz/chromium and puppeteer-core, LD_LIBRARY_PATH the libraries its Chromium needs, and
# FONTCONFIG_PATH its fonts.
#
#   MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=... docs/verification/dashboard-render/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$work/main" 2>/dev/null; git -C "$repo" worktree remove --force "$work/branch" 2>/dev/null; rm -rf "$work"' EXIT

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/dashboard-render" "$here/$run"
  cp "$here/drive.ts" "$here/bench.ts" "$tree/docs/verification/dashboard-render/"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && npm run -s build >/dev/null && node docs/verification/dashboard-render/drive.ts "$here/$run" >/dev/null \
    && for i in 1 2 3; do node docs/verification/dashboard-render/bench.ts; done | tee "$here/$run/bench.txt")
done
