#!/usr/bin/env bash
# Captures what a person, a client and a node see of node observations from every probe shape, on main and on this
# branch, each from its own worktree with this directory's copy of the scripts. Writes the first snapshot each real
# probe sends (main, the branch and the deployed release) and probe-frames.diff, main's against the branch's; main.txt,
# branch.txt and capture.diff; and the test runs on main's code with only the pins added, and on the branch, with
# tests.diff, the tests each run passed.
#
#   docs/verification/upgrade-observations/run.sh [main-commit] [pins-commit] [branch-commit] [deployed-commit]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
main=${1:-origin/main}
pins=${2:-$(git -C "$repo" log --format=%h -1 --grep '^test: pin what readers do with observations')}
branch=${3:-HEAD}
deployed=${4:-82a703f}
work=$(mktemp -d)
trees=()
trap 'for t in "${trees[@]}"; do git -C "$repo" worktree remove --force "$t" 2>/dev/null; done; rm -rf "$work"; git -C "$repo" worktree prune' EXIT

checkout() {
  local tree="$work/$1"
  git -C "$repo" worktree add --detach "$tree" "$2" >/dev/null
  trees+=("$tree")
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/upgrade-observations"
  cp "$here"/*.ts "$tree/docs/verification/upgrade-observations/"
  (cd "$tree" && node src/control/dashboard/build.ts >/dev/null)
  echo "$tree"
}

mkdir -p "$work/frames"
for run in deployed main branch; do
  commit=$main
  [ "$run" = branch ] && commit=$branch
  [ "$run" = deployed ] && commit=$deployed
  tree=$(checkout "$run" "$commit")
  (cd "$tree" && node --no-warnings docs/verification/upgrade-observations/capture-probe.ts "$work/frames/$run.json")
  cp "$work/frames/$run.json" "$here/probe-$run.json"
done
normal() { node -e 'const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); for (const k of ["observedAt", "probeBootId"]) e.observation[k] = "<" + k + ">"; e.observation.capacity.diskFreeGiB = "<diskFreeGiB>"; console.log(JSON.stringify(e, null, 1))' "$1"; }
diff -u --label probe-main.json --label probe-branch.json <(normal "$here/probe-main.json") <(normal "$here/probe-branch.json") > "$here/probe-frames.diff" || true
echo "probe-frames.diff: $(grep -c '^[-+][^-+]' "$here/probe-frames.diff" || true) changed lines"

for run in main branch; do
  {
    echo "$run: $(git -C "$work/$run" log --oneline -1)"
    (cd "$work/$run" && node --no-warnings docs/verification/upgrade-observations/capture.ts . "$work/frames" /dev/stdout)
  } > "$here/$run.txt"
done
diff -u --label main.txt --label branch.txt <(tail -n +2 "$here/main.txt") <(tail -n +2 "$here/branch.txt") > "$here/capture.diff" || true
echo "capture.diff: $(grep -c '^[-+][^-+]' "$here/capture.diff" || true) changed lines"

tests="src/reconcile.test.ts src/control/api.test.ts src/control/registry.test.ts src/control/dashboard.test.ts src/control/loop.test.ts src/control/chatgpt-token.test.ts src/probe/server.test.ts src/cli/nexus.test.ts"
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
