#!/usr/bin/env bash
# Runs drive.ts on main and on this branch, each from its own worktree with this directory's copy of the script, and
# saves each run's result.json and screenshots in main/ and branch/ here. MODULES names the node_modules that hold
# @sparticuz/chromium and puppeteer-core.
#
#   MODULES=... docs/verification/dashboard-client/run.sh [main-commit] [branch-commit]
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
  mkdir -p "$tree/docs/verification/dashboard-client" "$here/$run"
  cp "$here/drive.ts" "$tree/docs/verification/dashboard-client/"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && npm run -s build >/dev/null && node docs/verification/dashboard-client/drive.ts "$here/$run")
done
