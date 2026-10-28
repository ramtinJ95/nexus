#!/usr/bin/env bash
# Runs stack.ts on main and on this branch, each from its own worktree with this directory's copy of stack.ts, and
# saves each run's captures in main/ and branch/ here. Then runs the branch's pipeline tests against each checkout's
# code, into tests-main.txt and tests-branch.txt. MODULES names the node_modules that hold @sparticuz/chromium and
# puppeteer-core, LD_LIBRARY_PATH the libraries its Chromium needs, and FONTCONFIG_PATH the folder of a fonts.conf
# that lists its fonts. RUNS picks the runs, both by default.
#
#   MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=... docs/verification/pipeline-items/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT
tests="src/control/pipeline.test.ts src/control/api.test.ts src/control/registry.test.ts src/control/dashboard.test.ts src/cli/nexus.test.ts"

for run in ${RUNS:-main branch}; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/pipeline-items"
  cp "$here/stack.ts" "$tree/docs/verification/pipeline-items/"
  (cd "$tree" && npm run build >/dev/null)
  rm -rf "${here:?}/$run"
  mkdir -p "$here/$run"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && node docs/verification/pipeline-items/stack.ts drive src "$here/$run")
  for file in $tests; do git -C "$repo" show "${2:-HEAD}:$file" >"$tree/$file"; done
  # shellcheck disable=SC2086
  (cd "$tree" && node --test --test-timeout=60000 --test-name-pattern="item|pipeline" $tests 2>&1 | grep -E '^(✔|✖|ℹ (tests|pass|fail|cancelled))' | sed -E 's/ \([0-9.]+ms\)$//' | awk '!seen[$0]++') >"$here/tests-$run.txt" || true
done
