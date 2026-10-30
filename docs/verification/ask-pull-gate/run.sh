#!/usr/bin/env bash
# Runs stack.ts on main and on this branch, each from its own worktree with this directory's copy of stack.ts, and
# saves each run's captures in main/ and branch/ here. RUNS picks the runs, both by default. It needs passwordless sudo,
# to run the worker as the user `verify`, and the Claude token placeholder in /etc/profile.d/nexus-secrets.sh, as a
# pylon has.
#
#   docs/verification/ask-pull-gate/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
chmod 755 "$work"
trap 'for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT

for run in ${RUNS:-main branch}; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/ask-pull-gate"
  cp "$here/stack.ts" "$tree/docs/verification/ask-pull-gate/"
  (cd "$tree" && npm run build >/dev/null)
  rm -rf "${here:?}/$run"
  mkdir -p "$here/$run"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && node docs/verification/ask-pull-gate/stack.ts drive src "$here/$run")
done
