#!/usr/bin/env bash
# Runs stack.ts and drive.mjs on main and on this branch, each from its own worktree with this directory's copies of
# both files, and saves each run's captures in main/ and branch/ here. Then it runs the branch's nudge tests against
# each run's code, into tests.txt.
#
#   docs/verification/nudge-stalled-builder/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
stack=
trap '[ -n "$stack" ] && kill "$stack" 2>/dev/null; git -C "$repo" worktree remove --force "$work/main" 2>/dev/null; git -C "$repo" worktree remove --force "$work/branch" 2>/dev/null; rm -rf "$work"' EXIT

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  rm -rf "$here/$run"
  mkdir -p "$tree/docs/verification/nudge-stalled-builder" "$here/$run"
  cp "$here/stack.ts" "$here/drive.mjs" "$tree/docs/verification/nudge-stalled-builder/"
  (cd "$tree" && npm run build >/dev/null)
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && OUT="$here/$run" exec node docs/verification/nudge-stalled-builder/stack.ts) > "$work/$run.log" 2>&1 &
  stack=$!
  until grep -q '^{' "$work/$run.log"; do kill -0 "$stack" || { cat "$work/$run.log"; exit 1; }; sleep 0.5; done
  OUT="$here/$run" ROOT="$tree" node "$here/drive.mjs"
  kill "$stack"; wait "$stack" || true
  stack=
  git -C "$repo" show "${2:-HEAD}:src/control/nudge.test.ts" > "$tree/src/control/nudge.test.ts"
  (cd "$tree" && node --test src/control/nudge.test.ts) > "$here/$run/tests.txt" 2>&1 || true
done
