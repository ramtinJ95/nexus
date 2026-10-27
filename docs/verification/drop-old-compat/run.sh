#!/usr/bin/env bash
# Captures what a person, a node and a pylon controller see of the paths issue #135 removes, on main and on this
# branch, each from its own worktree with this directory's copy of the scripts. Writes main.txt, branch.txt and
# capture.diff; equivalence.txt, main's setupState against the branch's setupOnDisk; deployed-probe.txt, the branch's
# stream requests parsed by the release every node runs; and the pin tests' runs on main's code with only the pins
# added, and on the branch.
#
#   docs/verification/drop-old-compat/run.sh [main-commit] [pins-commit] [branch-commit] [deployed-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
main=${1:-origin/main}
pins=${2:-$(git -C "$repo" log --format=%h -1 --grep '^test: pin attach')}
branch=${3:-HEAD}
deployed=${4:-82a703f}
work=$(mktemp -d)
trees=()
trap 'for t in "${trees[@]}"; do git -C "$repo" worktree remove --force "$t" 2>/dev/null; done; rm -rf "$work"' EXIT

checkout() {
  local tree="$work/$1"
  git -C "$repo" worktree add --detach "$tree" "$2" >/dev/null
  trees+=("$tree")
  ln -s "$repo/node_modules" "$tree/node_modules"
  echo "$tree"
}

for run in main branch; do
  commit=$main
  [ "$run" = branch ] && commit=$branch
  tree=$(checkout "$run" "$commit")
  mkdir -p "$tree/docs/verification/drop-old-compat"
  cp "$here"/*.ts "$tree/docs/verification/drop-old-compat/"
  {
    echo "$run: $(git -C "$tree" log --oneline -1)"
    (cd "$tree" && node --no-warnings docs/verification/drop-old-compat/capture.ts . "$work/$run-urls.txt")
  } > "$here/$run.txt"
done
diff -u --label main.txt --label branch.txt <(tail -n +2 "$here/main.txt") <(tail -n +2 "$here/branch.txt") > "$here/capture.diff" || true
echo "capture.diff: $(grep -c '^[-+][^-+]' "$here/capture.diff" || true) changed lines"

{
  echo "main: $(git -C "$work/main" log --oneline -1)"
  (cd "$work/main" && node --no-warnings docs/verification/drop-old-compat/setup-equivalence.ts .)
} > "$here/equivalence.txt"
tail -1 "$here/equivalence.txt"

tree=$(checkout deployed "$deployed")
{
  echo "probe parser: $(git -C "$tree" log --oneline -1)"
  node --no-warnings "$here/deployed-probe.ts" "$tree" "$work/branch-urls.txt"
} > "$here/deployed-probe.txt"
cat "$here/deployed-probe.txt"

tests="src/cli/nexus.test.ts src/pylon-vm/runtime.test.ts src/pylon-vm/daemon.test.ts src/probe/server.test.ts src/guest-terminal.test.ts"
for run in pins branch; do
  tree=$work/branch
  [ "$run" = pins ] && tree=$(checkout pins "$pins")
  (cd "$tree" && node src/control/dashboard/build.ts >/dev/null)
  {
    echo "$(git -C "$tree" log --oneline -1)"
    (cd "$tree" && node --test $tests 2>&1 | grep -E '^(✔|✖|ℹ (tests|pass|fail))')
  } > "$here/tests-$run.txt"
  tail -3 "$here/tests-$run.txt"
done
