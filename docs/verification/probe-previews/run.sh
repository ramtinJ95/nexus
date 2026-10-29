#!/usr/bin/env bash
# Captures what the guest and the control plane see of the real probe entrypoint on main and on this branch, each from
# its own worktree with this directory's copy of the scripts. Writes main.txt, branch.txt and diff.txt.
#
#   docs/verification/probe-previews/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
trees=()
trap 'for t in "${trees[@]}"; do git -C "$repo" worktree remove --force "$t" 2>/dev/null; done; rm -rf "$work"' EXIT

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree=$work/$run
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  trees+=("$tree")
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/probe-previews"
  cp "$here"/capture.ts "$here"/stub-tailnet.ts "$tree/docs/verification/probe-previews/"
  (cd "$tree" && node --no-warnings docs/verification/probe-previews/capture.ts "$work/$run.txt")
  { echo "$run: $(git -C "$tree" log --oneline -1)"; cat "$work/$run.txt"; } > "$here/$run.txt"
done
diff -u "$here/main.txt" "$here/branch.txt" > "$here/diff.txt" || true
cat "$here/diff.txt"
