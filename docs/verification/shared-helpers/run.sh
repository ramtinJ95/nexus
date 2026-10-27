#!/usr/bin/env bash
# Runs capture.ts and the pinned test files against main and against this branch, each from its own worktree, and
# writes main.txt, branch.txt, tests-main.txt, tests-branch.txt and capture.diff here. "main" is main with only the
# pin commits on top, the latest commit on this branch whose subject says "before merging them". "branch" is the
# latest commit that changes code, so a later commit of these captures does not change what they name.
#
#   docs/verification/shared-helpers/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
pins=$(git -C "$repo" log -1 --format=%H --grep='before merging them' origin/main..HEAD)
code=$(git -C "$repo" log -1 --format=%H HEAD -- src deploy package.json)
work=$(mktemp -d)
trap 'for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT

tests="src/control/usage-limit.test.ts src/control/pr-watch.test.ts src/control/review.test.ts src/control/chatgpt-token.test.ts
  src/control/image-rollout.test.ts src/control/loop.test.ts src/deploy/install.test.ts src/deploy/worker.test.ts src/probe/serve.test.ts
  src/pylon-vm/services.test.ts src/pylon-vm-backend.test.ts src/control/mirror.test.ts src/docker-backend.test.ts"

for run in main branch; do
  commit=${1:-$pins}
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
    # Durations differ run to run, so they are cut to make the two files comparable.
    (cd "$tree" && node --test --test-reporter=spec $tests 2>&1 || true) | sed -E 's/ \([0-9.]+m?s\)$//; /^ℹ duration_ms/d'
  } > "$here/tests-$run.txt"
done

diff -u "$here/main.txt" "$here/branch.txt" > "$here/capture.diff" || true
tail -n 8 "$here/tests-main.txt" "$here/tests-branch.txt"
cat "$here/capture.diff"
