#!/usr/bin/env bash
# Runs stack.ts on main and on this branch, each from its own worktree, twice: with agent-usage.py as it is, and with
# it grown by 12 KiB of comment, as a helper that gains features grows. Saves each run's output here.
#
#   docs/verification/pipe-helpers/run.sh [main-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'for run in main branch; do git -C "$repo" worktree remove --force "$work/$run" 2>/dev/null || true; done; rm -rf "$work"' EXIT

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add -q --detach "$tree" "$commit"
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/pipe-helpers"
  cp "$here/stack.ts" "$tree/docs/verification/pipe-helpers/"
  {
    echo "$run: $(git -C "$tree" log --oneline -1)"
    echo "## agent-usage.py as committed"
    (cd "$tree" && node docs/verification/pipe-helpers/stack.ts)
    python3 -c 'import sys; open(sys.argv[1], "a").write(("# " + "x" * 98 + "\n") * 123)' "$tree/src/agent-usage.py"
    echo "## agent-usage.py grown to $(wc -c < "$tree/src/agent-usage.py") bytes"
    (cd "$tree" && node docs/verification/pipe-helpers/stack.ts)
  } > "$here/$run.txt" 2>&1
  cat "$here/$run.txt"
done
