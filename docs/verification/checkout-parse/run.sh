#!/usr/bin/env bash
# Runs capture.ts and the pinned test files against main and against this branch, each from its own worktree, and
# writes main.txt, branch.txt, tests-main.txt, tests-branch.txt and capture.diff here. "branch" is the latest commit
# that changes code, so a later commit of these captures does not change what they name.
#
#   docs/verification/checkout-parse/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
code=$(git -C "$repo" log -1 --format=%H HEAD -- src)
work=$(mktemp -d)
trap 'for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT

tests="src/outputs.test.ts src/checkout-files.test.ts src/git-facts.test.ts src/agent-setup.test.ts src/artifacts.test.ts"

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-$code}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  {
    echo "# $run: $(git -C "$tree" log --oneline -1)"
    node "$here/capture.ts" "$tree"
  } > "$here/$run.txt"
  {
    echo "# $run: $(git -C "$tree" log --oneline -1)"
    # The branch's test files run in both trees, so main's run shows which of the new tests fail there.
    cp "$repo"/src/{outputs,checkout-files,git-facts,agent-setup,artifacts}.test.ts "$tree/src/"
    # Durations differ run to run, so they are cut to make the two files comparable.
    (cd "$tree" && node --test --test-reporter=spec $tests 2>&1 || true) | sed -E 's/ \([0-9.]+m?s\)$//; /^ℹ duration_ms/d'
  } > "$here/tests-$run.txt"
done

diff -u "$here/main.txt" "$here/branch.txt" > "$here/capture.diff" || true
tail -n 8 "$here/tests-main.txt" "$here/tests-branch.txt"
cat "$here/capture.diff"
