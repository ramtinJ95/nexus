#!/usr/bin/env bash
# Runs stack.ts on main and on this branch, each from its own worktree with this directory's copy of stack.ts, and
# saves each run's captures in main/ and branch/ here. Then runs the branch's drive tool tests, with the branch's test
# fixtures, against each checkout's code, into tests-main.txt and tests-branch.txt.
#
#   docs/verification/drive-tools/run.sh [main-commit] [branch-commit]
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
  mkdir -p "$tree/docs/verification/drive-tools"
  cp "$here/stack.ts" "$tree/docs/verification/drive-tools/"
  (cd "$tree" && npm run build >/dev/null)
  rm -rf "${here:?}/$run"
  mkdir -p "$here/$run"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  for file in src/harness/test-fixture.ts; do git -C "$repo" show "${2:-HEAD}:$file" >"$tree/$file"; done
  (cd "$tree" && node docs/verification/drive-tools/stack.ts drive src "$here/$run")
  for file in src/harness/drive-tools.test.ts src/harness/drive-fixture.ts src/control/drive.test.ts; do git -C "$repo" show "${2:-HEAD}:$file" >"$tree/$file"; done
  (cd "$tree" && node --test --test-timeout=60000 src/harness/drive-tools.test.ts src/control/drive.test.ts 2>&1 | grep -E '^(✔|✖|ℹ (tests|pass|fail|cancelled))|^Error ' | sed -E "s/ \([0-9.]+ms\)$//; s|$tree|<checkout>|g" | awk '!seen[$0]++') >"$here/tests-$run.txt" || true
done
