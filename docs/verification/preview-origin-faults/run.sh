#!/usr/bin/env bash
# Captures what the preview gateway of the real probe entrypoint answers on main and on this branch, each from
# its own worktree with this directory's copy of the scripts. Writes main.txt, branch.txt and diff.txt.
#
#   docs/verification/preview-origin-faults/run.sh [main-commit] [branch-commit]
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
  mkdir -p "$tree/docs/verification/preview-origin-faults"
  cp "$here"/capture.ts "$here"/stub-tailnet.ts "$tree/docs/verification/preview-origin-faults/"
  (cd "$tree" && node --no-warnings docs/verification/preview-origin-faults/capture.ts "$work/$run.txt")
  { echo "$run: $(git -C "$tree" log --oneline -1)"; cat "$work/$run.txt"; } > "$here/$run.txt"
done
diff -u "$here/main.txt" "$here/branch.txt" > "$here/diff.txt" || true
cat "$here/diff.txt"
