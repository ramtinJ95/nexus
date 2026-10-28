#!/usr/bin/env bash
# Runs measure.ts on main and on this branch, each from its own worktree with this directory's copy of the script,
# saves each run's counts and what its client saw in main/ and branch/ here, and writes the comparison to compare.txt.
#
#   docs/verification/transcript-render-once/run.sh [main-commit] [branch-commit]
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
  mkdir -p "$tree/docs/verification/transcript-render-once" "$here/$run"
  cp "$here/measure.ts" "$tree/docs/verification/transcript-render-once/"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && npm run -s build >/dev/null && node docs/verification/transcript-render-once/measure.ts "$here/$run") >/dev/null
done

node "$here/compare.ts" "$here/main" "$here/branch" | tee "$here/compare.txt"
