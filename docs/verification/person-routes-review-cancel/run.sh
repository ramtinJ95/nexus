#!/usr/bin/env bash
# Runs stack.ts and drive.mjs on main and on this branch, each from its own worktree with this directory's copies of
# both files, and saves each run's captures in main/ and branch/ here. Then it runs the branch's review, API, dashboard and
# CLI tests against each run's code, and saves the failures and counts in tests.txt. MODULES names the node_modules that hold @sparticuz/chromium and puppeteer-core,
# LD_LIBRARY_PATH the libraries its Chromium needs, and FONTCONFIG_PATH the fonts.conf of the fonts it ships.
#
#   MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=/tmp/fonts docs/verification/person-routes-review-cancel/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
stack=
trap '[ -n "$stack" ] && kill "$stack" 2>/dev/null; git -C "$repo" worktree remove --force "$work/main" 2>/dev/null; git -C "$repo" worktree remove --force "$work/branch" 2>/dev/null; rm -rf "$work"' EXIT

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  rm -rf "$here/$run"
  mkdir -p "$tree/docs/verification/person-routes-review-cancel" "$here/$run"
  cp "$here/stack.ts" "$here/drive.mjs" "$tree/docs/verification/person-routes-review-cancel/"
  (cd "$tree" && npm run build >/dev/null)
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && OUT="$here/$run" exec node docs/verification/person-routes-review-cancel/stack.ts) > "$work/$run.log" 2>&1 &
  stack=$!
  until grep -q '^{' "$work/$run.log"; do kill -0 "$stack" || { cat "$work/$run.log"; exit 1; }; sleep 0.5; done
  OUT="$here/$run" ROOT="$tree" node "$here/drive.mjs"
  kill "$stack"; wait "$stack" || true
  stack=
  for test in src/control/review.test.ts src/control/api.test.ts src/control/dashboard.test.ts src/cli/nexus.test.ts; do git -C "$repo" show "${2:-HEAD}:$test" > "$tree/$test"; done
  (cd "$tree" && node --test src/control/review.test.ts src/control/api.test.ts src/control/dashboard.test.ts src/cli/nexus.test.ts) > "$work/$run-tests.txt" 2>&1 || true
  grep -E '^(✖|ℹ (tests|pass|fail))' "$work/$run-tests.txt" | sort -u > "$here/$run/tests.txt"
done
