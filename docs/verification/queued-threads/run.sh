#!/usr/bin/env bash
# Runs stack.ts on main and on this branch, each from its own worktree with this directory's copy of stack.ts, and
# saves each run's captures in main/ and branch/ here. MODULES names the node_modules that hold @sparticuz/chromium and
# puppeteer-core, LD_LIBRARY_PATH the libraries its Chromium needs, and FONTCONFIG_PATH the folder of its fonts.conf,
# which al2023.tar.br and fonts.tar.br in its bin/ unpack to.
#
#   MODULES=... LD_LIBRARY_PATH=/tmp/lib FONTCONFIG_PATH=/tmp docs/verification/queued-threads/run.sh [main-commit] [branch-commit]
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
  mkdir -p "$tree/docs/verification/queued-threads"
  cp "$here/stack.ts" "$tree/docs/verification/queued-threads/"
  (cd "$tree" && npm run build >/dev/null)
  rm -rf "${here:?}/$run"
  mkdir -p "$here/$run"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && node docs/verification/queued-threads/stack.ts drive src "$here/$run")
done
