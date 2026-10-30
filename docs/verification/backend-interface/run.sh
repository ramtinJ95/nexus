#!/bin/sh
# Runs capture.ts on this checkout and on a worktree of main, and writes branch.txt and main.txt beside it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
base=${1:-origin/main}
worktree=$(mktemp -d /tmp/nexus-bif-main-XXXXXX)
trap 'git -C "$repo" worktree remove --force "$worktree"' EXIT
git -C "$repo" worktree add --detach --quiet "$worktree" "$base"
ln -s "$repo/node_modules" "$worktree/node_modules"
mkdir -p "$worktree/docs/verification/backend-interface"
cp "$here/capture.ts" "$worktree/docs/verification/backend-interface/"
(cd "$worktree" && node docs/verification/backend-interface/capture.ts) > "$here/main.txt"
(cd "$repo" && node docs/verification/backend-interface/capture.ts) > "$here/branch.txt"
diff "$here/main.txt" "$here/branch.txt" || true
