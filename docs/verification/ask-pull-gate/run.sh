#!/usr/bin/env bash
# Runs stack.ts on main and on this branch, each from its own worktree with this directory's copy of stack.ts, and
# saves each run's captures in main/ and branch/ here. The mixed run is the branch's control plane with main's
# images/pylon, as a pylon booted from an image before the branch is, saved in mixed/. RUNS picks the runs, all three
# by default. It needs passwordless sudo,
# to run the worker as the user `verify`, and the Claude token placeholder in /etc/profile.d/nexus-secrets.sh, as a
# pylon has.
#
#   docs/verification/ask-pull-gate/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
chmod 755 "$work"
trap 'for run in main branch mixed; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT

for run in ${RUNS:-main branch mixed}; do
  commit=${1:-origin/main}
  [ "$run" != main ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  [ "$run" = mixed ] && git -C "$tree" checkout "${1:-origin/main}" -- images/pylon
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/ask-pull-gate"
  cp "$here/stack.ts" "$tree/docs/verification/ask-pull-gate/"
  (cd "$tree" && npm run build >/dev/null)
  rm -rf "${here:?}/$run"
  mkdir -p "$here/$run"
  echo "$run: $(git -C "$tree" log --oneline -1)$([ "$run" = mixed ] && echo ", images/pylon from $(git -C "$repo" rev-parse --short "${1:-origin/main}")")" | tee "$here/$run/commit.txt"
  (cd "$tree" && node docs/verification/ask-pull-gate/stack.ts drive src "$here/$run")
done
