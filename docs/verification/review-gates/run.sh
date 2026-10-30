#!/usr/bin/env bash
# Runs stack.ts on main and on this branch, each from its own worktree with this directory's copy of it, and saves each
# run's run.txt and github.log in main/ and branch/ here.
#
#   docs/verification/review-gates/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'for run in main branch; do git -C "$repo" worktree remove --force "${work:?}/$run" 2>/dev/null || true; done; rm -rf "${work:?}"' EXIT

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add -q --detach "$tree" "$commit" >/dev/null 2>&1
  ln -s "$repo/node_modules" "$tree/node_modules"
  rm -rf "${here:?}/${run:?}"
  mkdir -p "$tree/docs/verification/review-gates" "$here/$run"
  cp "$here/stack.ts" "$tree/docs/verification/review-gates/"
  (cd "$tree" && npm run build >/dev/null)
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && OUT="$here/$run" node docs/verification/review-gates/stack.ts)
  cat "$here/$run/run.txt"
done
