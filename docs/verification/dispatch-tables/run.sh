#!/usr/bin/env bash
# Captures what clients and nodes see of the API's health, release, deployer and event routes and streams, and of the
# probe entrypoint, on main and on this branch, each from its own worktree with this directory's copy of the scripts.
# Writes main/ and branch/, diff.txt, and the pin tests' runs: on main's code with only the pins added, and on the branch.
#
#   docs/verification/dispatch-tables/run.sh [main-commit] [pins-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
main=${1:-origin/main}
pins=${2:-$(git -C "$repo" log --format=%h -1 --grep '^test(probe): pin each command kind')}
branch=${3:-HEAD}
work=$(mktemp -d)
trees=()
trap 'for t in "${trees[@]}"; do git -C "$repo" worktree remove --force "$t" 2>/dev/null; done; rm -rf "$work"' EXIT

checkout() {
  local tree="$work/$1"
  git -C "$repo" worktree add --detach "$tree" "$2" >/dev/null
  trees+=("$tree")
  ln -s "$repo/node_modules" "$tree/node_modules"
  (cd "$tree" && node src/control/dashboard/build.ts >/dev/null)
  echo "$tree"
}

for run in main branch; do
  commit=$main
  [ "$run" = branch ] && commit=$branch
  tree=$(checkout "$run" "$commit")
  mkdir -p "$tree/docs/verification/dispatch-tables" "$here/$run"
  cp "$here"/capture-api.ts "$here"/capture-probe-main.ts "$here"/stub-tailnet.ts "$tree/docs/verification/dispatch-tables/"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  (cd "$tree" && node --no-warnings docs/verification/dispatch-tables/capture-api.ts "$here/$run/api.txt")
  (cd "$tree" && node --no-warnings docs/verification/dispatch-tables/capture-probe-main.ts "$here/$run/probe-main.txt")
done

{
  diff -u --label main/api.txt --label branch/api.txt "$here/main/api.txt" "$here/branch/api.txt" || true
  diff -u --label main/probe-main.txt --label branch/probe-main.txt "$here/main/probe-main.txt" "$here/branch/probe-main.txt" || true
} > "$here/diff.txt"
echo "diff.txt: $(grep -c '^[-+][^-+]' "$here/diff.txt" || true) changed lines"

for run in pins branch; do
  commit=$pins
  [ "$run" = branch ] && commit=$branch
  tree=$work/branch
  [ "$run" = pins ] && tree=$(checkout pins "$commit")
  {
    echo "$(git -C "$tree" log --oneline -1)"
    (cd "$tree" && node --test src/control/api.test.ts src/probe/server.test.ts 2>&1 | grep -E '^(✔|✖|ℹ (tests|pass|fail))')
  } > "$here/tests-$run.txt"
  tail -3 "$here/tests-$run.txt"
done
