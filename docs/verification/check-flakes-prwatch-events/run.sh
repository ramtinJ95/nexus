#!/usr/bin/env bash
# Runs stack.ts and drive.mjs on main and on this branch, each from its own worktree with this directory's copies of
# both files, and saves each run's captures in main/ and branch/ here. Each run also runs that commit's own
# .nexus/check in a clean worktree whose npm registry refuses connections, into check.txt, and the branch's new gate
# and PR-watch tests against that commit's code, into tests.txt.
#
#   docs/verification/check-flakes-prwatch-events/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
name=$(basename "$here")
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
stack=
trap '[ -n "$stack" ] && kill "$stack" 2>/dev/null; for t in "$work"/*/; do git -C "$repo" worktree remove --force "$t" 2>/dev/null; done; rm -rf "$work"' EXIT

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  rm -rf "$here/$run"
  mkdir -p "$tree/docs/verification/$name" "$here/$run"
  cp "$here/stack.ts" "$here/drive.mjs" "$tree/docs/verification/$name/"
  (cd "$tree" && npm run build >/dev/null)
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"

  git -C "$repo" worktree add --detach "$work/check-$run" "$commit" >/dev/null
  { echo '$ .nexus/check   # npm_config_registry=http://127.0.0.1:9/ npm_config_fetch_retries=0'
    (cd "$work/check-$run" && npm_config_registry=http://127.0.0.1:9/ npm_config_fetch_retries=0 npm_config_cache="$work/npm-cache-$run" ./.nexus/check 2>&1 | grep -v '^npm error A complete log' ; exit "${PIPESTATUS[0]}") && status=0 || status=$?
    echo "[exit $status]"; } > "$here/$run/check.txt"
  cat "$here/$run/check.txt"

  (cd "$tree" && OUT="$here/$run" exec node "docs/verification/$name/stack.ts") > "$work/$run.log" 2>&1 &
  stack=$!
  until grep -q '^{' "$work/$run.log"; do kill -0 "$stack" || { cat "$work/$run.log"; exit 1; }; sleep 0.5; done
  OUT="$here/$run" ROOT="$tree" node "$here/drive.mjs"
  kill "$stack"; wait "$stack" || true
  stack=
  for file in src/control/gate.test.ts src/control/pr-watch.test.ts; do git -C "$repo" show "${2:-HEAD}:$file" > "$tree/$file"; done
  (cd "$tree" && node --test --test-name-pattern 'exits 75|pull-request.error|queued thread.s predecessor is the predecessor.s error' src/control/gate.test.ts src/control/pr-watch.test.ts) > "$here/$run/tests.txt" 2>&1 || true
done
