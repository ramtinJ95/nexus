#!/usr/bin/env bash
# Runs stack.ts and drive.mjs on main and on this branch, each from its own worktree with this directory's copies of
# stack.ts, vm-stand-in.ts and drive.mjs, and saves each run's captures in main/ and branch/ here. Then runs the
# branch's host, redaction and log-tail tests against the branch, into tests-branch.txt. MODULES names the
# node_modules that hold @sparticuz/chromium and puppeteer-core, LD_LIBRARY_PATH the libraries its Chromium needs,
# and FONTCONFIG_PATH its fonts. RUNS picks the runs, both by default.
#
#   MODULES=... LD_LIBRARY_PATH=... FONTCONFIG_PATH=... docs/verification/node-diagnostics/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
stack=
stop() { [ -z "$stack" ] || { kill "$stack" 2>/dev/null || true; wait "$stack" 2>/dev/null || true; }; stack=; }
trap 'stop; for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT

for run in ${RUNS:-main branch}; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  rm -rf "${here:?}/$run"
  mkdir -p "$tree/docs/verification/node-diagnostics" "$here/$run"
  cp "$here/stack.ts" "$here/vm-stand-in.ts" "$here/drive.mjs" "$tree/docs/verification/node-diagnostics/"
  (cd "$tree" && npm run build >/dev/null)
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && EVIDENCE="$here/$run" exec node docs/verification/node-diagnostics/stack.ts) >"$here/$run/stack.out" 2>&1 &
  stack=$!
  until grep -q '^{' "$here/$run/stack.out"; do kill -0 "$stack" || { cat "$here/$run/stack.out"; exit 1; }; sleep 0.5; done
  OUT="$here/$run" ROOT="$tree" STACK=$(grep '^{' "$here/$run/stack.out") node "$here/drive.mjs"
  stop
  if [ "$run" = branch ]; then
    (cd "$tree" && node --test --test-timeout=60000 src/probe/host.test.ts src/probe/redact.test.ts \
      --test-name-pattern="host|hwmon|thermal|redact|credential|ordinary|log tail|controller failed carries|node health" src/probe/server.test.ts src/pylon-vm-backend.test.ts 2>&1 \
      | grep -E '^(✔|✖|ℹ (tests|pass|fail|cancelled))' | sed -E 's/ \([0-9.]+ms\)$//') >"$here/tests-branch.txt" || true
  fi
done
