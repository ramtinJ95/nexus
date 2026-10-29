#!/usr/bin/env bash
# Runs capture.ts and bootstrap.sh against main and against this branch, each from its own worktree with this
# directory's copy of the scripts, and writes main/, branch/ and diff.txt here. Then runs this branch's deploy tests on
# main's code and on the branch, into tests-main.txt and tests-branch.txt. bootstrap.sh needs sudo. "branch" is the
# latest commit that changes code, so a later commit of these captures does not change what they name.
#
#   docs/verification/deploy-worker/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
main=${1:-$(git -C "$repo" merge-base origin/main HEAD)}
branch=${2:-$(git -C "$repo" log -1 --format=%H HEAD -- src deploy package.json ":(exclude)*.md")}
work=$(mktemp -d)
trap 'for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT
tests="src/deploy/plan.test.ts src/deploy/install.test.ts src/deploy/worker.test.ts src/deploy/prerequisites.test.ts"

for run in main branch; do
  commit=$main
  [ "$run" = branch ] && commit=$branch
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  (cd "$tree" && node src/control/dashboard/build.ts >/dev/null)
  mkdir -p "$tree/docs/verification/deploy-worker" "$here/$run"
  cp "$here/capture.ts" "$here/bootstrap.sh" "$tree/docs/verification/deploy-worker/"
  git -C "$tree" log --oneline -1 > "$here/$run/commit.txt"
  (cd "$tree" && node --no-warnings docs/verification/deploy-worker/capture.ts "$here/$run/capture.txt")
  sudo env PATH="$PATH" unshare --mount --propagation private bash "$tree/docs/verification/deploy-worker/bootstrap.sh" "$tree" > "$here/$run/bootstrap.txt"
  for file in $tests; do git -C "$repo" show "$branch:$file" > "$tree/$file"; done
  {
    echo "# $run's code, $(cat "$here/$run/commit.txt"), with the branch's tests"
    # Durations differ run to run, so they are cut to make the two files comparable.
    (cd "$tree" && node --test $tests 2>&1 || true) | grep -E '^(✔|✖|ℹ (tests|pass|fail))' | sed -E 's/ \([0-9.]+m?s\)$//' | awk '!seen[$0]++'
  } > "$here/tests-$run.txt"
done

{
  for name in capture bootstrap; do
    diff -u --label "main/$name.txt" --label "branch/$name.txt" "$here/main/$name.txt" "$here/branch/$name.txt" || true
  done
} > "$here/diff.txt"
tail -n 3 "$here/tests-main.txt" "$here/tests-branch.txt"
echo "diff.txt: $(grep -c '^[-+][^-+]' "$here/diff.txt" || true) changed lines"
