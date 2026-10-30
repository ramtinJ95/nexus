#!/usr/bin/env bash
# Captures what clients see of each agent kind on main and on this branch, with this directory's copy of the capture
# script in each ref's worktree, so both run the same script against their own code. Writes main/, branch/ and
# diff.txt here.
#
#   docs/verification/api-thread-routes/run.sh [main-ref] [branch-ref]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
main=${1:-origin/main}
branch=${2:-HEAD}
work=$(mktemp -d)
trees=()
trap 'for t in "${trees[@]}"; do git -C "$repo" worktree remove --force "$t" 2>/dev/null; done; rm -rf "$work"' EXIT

for run in main branch; do
  commit=$main
  [ "$run" = branch ] && commit=$branch
  tree=$work/$run
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null 2>&1
  trees+=("$tree")
  ln -s "$repo/node_modules" "$tree/node_modules"
  (cd "$tree" && node src/control/dashboard/build.ts >/dev/null)
  rm -rf "${here:?}/$run"
  mkdir -p "$here/$run" "$tree/docs/verification/api-thread-routes"
  cp "$here"/*.ts "$tree/docs/verification/api-thread-routes/"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  if ! (cd "$tree" && node --no-warnings docs/verification/api-thread-routes/capture-api.ts "$here/$run/api.txt") 2>"$work/$run.err"; then
    { echo "capture-api.ts failed:"; sed "s|$work/$run|<tree>|g" "$work/$run.err"; } >> "$here/$run/api.txt"
  fi
  echo "  api.txt: $(wc -l < "$here/$run/api.txt") lines"
done

diff -u --label main/api.txt --label branch/api.txt "$here/main/api.txt" "$here/branch/api.txt" > "$here/diff.txt" || true
echo "diff.txt: $(grep -c '^[-+][^-+]' "$here/diff.txt" || true) changed lines"
