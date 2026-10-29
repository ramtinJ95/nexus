#!/usr/bin/env bash
# Runs control.ts and drive.sh on main and on this branch, each from its own worktree with this directory's copies of
# them, and saves each run's transcript in main.txt and branch.txt here. RUNS picks the runs, both by default.
#
#   docs/verification/api-boundary/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
# A socket path must fit in 108 bytes, so the fake tailscaled listens in a short directory.
sockets=$(mktemp -d /tmp/nxa-XXXX)
control=
cleanup() {
  if [ -n "$control" ]; then kill "$control" 2>/dev/null || true; fi
  for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done
  rm -rf "$work" "$sockets"
}
trap cleanup EXIT

for run in ${RUNS:-main branch}; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/api-boundary" "$work/$run-state"
  cp "$here/control.ts" "$here/drive.sh" "$tree/docs/verification/api-boundary/"
  (cd "$tree" && npm run build >/dev/null)
  if curl -s -o /dev/null http://127.0.0.1:7470/v1/health; then echo "something already listens on 127.0.0.1:7470" >&2; exit 1; fi
  (cd "$tree" && WORK="$work/$run-state" SOCKETS="$sockets" exec node docs/verification/api-boundary/control.ts > "$work/$run-control.log" 2>&1) &
  control=$!
  until curl -s -o /dev/null http://127.0.0.1:7470/v1/health; do sleep 0.2; done
  { echo "$run: $(git -C "$tree" log --oneline -1)"; echo; (cd "$tree" && WORK="$work/$run-state" bash docs/verification/api-boundary/drive.sh); } \
    | sed "s|$work/$run-state|\$WORK|g" > "$here/$run.txt"
  kill "$control"; wait "$control" || true
  control=
done
