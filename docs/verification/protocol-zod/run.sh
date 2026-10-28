#!/usr/bin/env bash
# Captures what every protocol and session parser makes of the payloads in cases.ts, on main and on this branch, each
# from its own worktree with this directory's copy of the scripts. Writes main.txt, branch.txt and
# compare.txt; then runs the pin tests and the full suite on main's code with only the pins added, and on the branch,
# into tests-pins.txt and tests-branch.txt, with tests.diff, the tests each run passed.
#
#   docs/verification/protocol-zod/run.sh [main-commit] [pins-commit] [branch-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
main=${1:-origin/main}
pins=${2:-$(git -C "$repo" log --format=%h -1 --grep '^test: pin what the protocol and session parsers accept and return')}
branch=${3:-HEAD}
work=$(mktemp -d)
trees=()
trap 'for t in "${trees[@]}"; do git -C "$repo" worktree remove --force "$t" 2>/dev/null; done; rm -rf "$work"; git -C "$repo" worktree prune' EXIT

checkout() {
  local tree="$work/$1"
  git -C "$repo" worktree add --detach "$tree" "$2" >/dev/null
  trees+=("$tree")
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/protocol-zod"
  cp "$here"/*.ts "$tree/docs/verification/protocol-zod/"
  (cd "$tree" && node src/control/dashboard/build.ts >/dev/null)
  echo "$tree"
}

for run in main branch; do
  commit=$main
  [ "$run" = branch ] && commit=$branch
  tree=$(checkout "$run" "$commit")
  (cd "$tree" && node --no-warnings docs/verification/protocol-zod/capture.ts . "$work/$run.txt")
  { echo "$run: $(git -C "$tree" log --oneline -1)"; cat "$work/$run.txt"; } > "$here/$run.txt"
done
echo "main.txt against branch.txt: $(diff <(tail -n +2 "$here/main.txt") <(tail -n +2 "$here/branch.txt") | grep -c '^[<>]' || true) changed lines"
node --no-warnings "$here/compare.ts" "$work/main.txt" "$work/branch.txt" > "$here/compare.txt"
head -20 "$here/compare.txt"

tests="src/protocol.test.ts src/sessions.test.ts"
for run in pins branch; do
  tree=$work/branch
  [ "$run" = pins ] && tree=$(checkout pins "$pins")
  {
    echo "$run: $(git -C "$tree" log --oneline -1)"
    (cd "$tree" && node --test --test-timeout=600000 $tests 2>&1 | grep -E '^(✔|✖|ℹ (tests|pass|fail))') || true
    echo "full suite:"
    (cd "$tree" && npm test 2>&1 | grep -E '^(✖|ℹ (tests|pass|fail))') || true
  } > "$here/tests-$run.txt"
  tail -3 "$here/tests-$run.txt"
done
names() { grep '^✔' "$1" | sed 's/ ([0-9.]*ms)$//' | sort; }
diff -u --label tests-pins.txt --label tests-branch.txt <(names "$here/tests-pins.txt") <(names "$here/tests-branch.txt") > "$here/tests.diff" || true
