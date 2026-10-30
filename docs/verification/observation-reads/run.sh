#!/usr/bin/env bash
# Runs measure.ts, and this branch's new tests, on main and on this branch, each from its own worktree with this
# directory's copy of the script and the branch's test files, and writes main.txt, branch.txt, compare.txt,
# tests-main.txt and tests-branch.txt here.
#
#   docs/verification/observation-reads/run.sh [main-commit] [branch-commit] [pylons]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$work/main" 2>/dev/null; git -C "$repo" worktree remove --force "$work/branch" 2>/dev/null; rm -rf "$work"' EXIT
branch=${2:-HEAD}
tests=(src/control/observed.test.ts src/control/peers.test.ts src/control/loop.test.ts src/control/registry.test.ts src/control/usage.test.ts)
pattern="last listed it, online or not|reads the nodes' tailnet IDs once|reads its node's record at most once|answer the same with the node's observation passed|a deleted thread's not at all|still runs one at a time"

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=$branch
  tree="$work/$run"
  git -C "$repo" worktree add --quiet --detach "$tree" "$commit"
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/observation-reads"
  cp "$here/measure.ts" "$tree/docs/verification/observation-reads/"
  for t in "${tests[@]}"; do git -C "$repo" show "$branch:$t" > "$tree/$t"; done
  (cd "$tree" && echo "$run: $(git log --oneline -1)" && node --no-warnings docs/verification/observation-reads/measure.ts "${3:-50}") > "$here/$run.txt"
  (cd "$tree" && node --test --test-timeout=60000 --test-reporter=spec --test-name-pattern="$pattern" "${tests[@]}" 2>&1 | grep -E '^(✔|✖|ℹ (pass|fail))' | grep -v 'failing tests:' | sed -E 's/ \([0-9.]+ms\)$//' | sort -u) > "$here/tests-$run.txt" || true
done

{
  printf '| measure | main | branch |\n|---|---|---|\n'
  paste <(tail -n +2 "$here/main.txt") <(tail -n +2 "$here/branch.txt") | awk -F '\t' '{ printf "| %s | %s | %s |\n", $1, $2, $4 }'
} | tee "$here/compare.txt"
