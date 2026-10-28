#!/usr/bin/env bash
# Runs capture.ts on main and on this branch, each from its own worktree with this directory's copy of capture.ts,
# and saves each run's output in main.txt and branch.txt here, with thread IDs and times replaced.
#
#   docs/verification/person-only-thread-starts/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/person-only-thread-starts"
  cp "$here/capture.ts" "$tree/docs/verification/person-only-thread-starts/"
  (cd "$tree" && npm run build >/dev/null)
  { echo "$run: $(git -C "$tree" log --oneline -1)"; echo; (cd "$tree" && node docs/verification/person-only-thread-starts/capture.ts); } 2>&1 \
    | sed -E -e 's/th-[0-9a-f]{12}/<thread>/g' -e 's/"(createdAt|lastHumanActivityAt)": [0-9]+/"\1": <time>/' >"$here/$run.txt"
done
