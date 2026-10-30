#!/usr/bin/env bash
# Runs capture.ts against main and against this branch, each from its own worktree with this directory's copy of the
# script, and writes main/, branch/ and diff.txt here. Then runs this branch's tests of the changed files on main's code
# and on the branch, into tests-main.txt and tests-branch.txt. "branch" is the latest commit that changes code, so a
# later commit of these captures does not change what they name.
#
#   docs/verification/control-wiring/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
main=${1:-$(git -C "$repo" merge-base origin/main HEAD)}
branch=${2:-$(git -C "$repo" log -1 --format=%H HEAD -- src deploy package.json ":(exclude)*.md")}
work=$(mktemp -d)
trap 'for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT
tests="src/control/api.test.ts src/control/peers.test.ts src/control/registry.test.ts src/control/drain.test.ts src/control/main.test.ts src/control/chatgpt-token.test.ts src/control/loop.test.ts"

for run in main branch; do
  commit=$main
  [ "$run" = branch ] && commit=$branch
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/control-wiring" "$here/$run"
  cp "$here/capture.ts" "$tree/docs/verification/control-wiring/"
  git -C "$tree" log --oneline -1 > "$here/$run/commit.txt"
  (cd "$tree" && node src/control/dashboard/build.ts >/dev/null)
  (cd "$tree" && node --no-warnings docs/verification/control-wiring/capture.ts "$here/$run/capture.txt" >/dev/null 2>&1)
  for file in $tests; do git -C "$repo" show "$branch:$file" > "$tree/$file"; done
  {
    echo "# $run's code, $(cat "$here/$run/commit.txt"), with the branch's tests"
    # Durations differ run to run, so they are cut to make the two files comparable.
    (cd "$tree" && node --test --test-timeout=600000 $tests 2>&1 || true) | grep -E '^(✔|✖|ℹ (tests|pass|fail))' | sed -E 's/ \([0-9.]+m?s\)$//' | awk '!seen[$0]++'
  } > "$here/tests-$run.txt"
done

diff -u --label main/capture.txt --label branch/capture.txt "$here/main/capture.txt" "$here/branch/capture.txt" > "$here/diff.txt" || true
tail -n 3 "$here/tests-main.txt" "$here/tests-branch.txt"
