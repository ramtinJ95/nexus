#!/usr/bin/env bash
# Runs measure.ts, and this branch's new tests, on main and on this branch, each from its own worktree with this
# directory's copy of the script and the branch's test files, and writes main.txt, branch.txt, compare.txt and
# tests-main.txt, tests-branch.txt here.
#
#   docs/verification/registry-reads/run.sh [main-commit] [branch-commit] [threads]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$work/main" 2>/dev/null; git -C "$repo" worktree remove --force "$work/branch" 2>/dev/null; rm -rf "$work"' EXIT
branch=${2:-HEAD}
tests=(src/control/registry.test.ts src/harness/activity.test.ts src/harness/host.test.ts)
pattern='threads\(\) reads each|storedThreads reads only|deploy drain set to null|harness threads at start|tallies and room|parked state is reported at track|each deleted conversation aborted'

for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=$branch
  tree="$work/$run"
  git -C "$repo" worktree add --quiet --detach "$tree" "$commit"
  ln -s "$repo/node_modules" "$tree/node_modules"
  mkdir -p "$tree/docs/verification/registry-reads"
  cp "$here/measure.ts" "$tree/docs/verification/registry-reads/"
  for t in "${tests[@]}"; do git -C "$repo" show "$branch:$t" > "$tree/$t"; done
  (cd "$tree" && echo "$run: $(git log --oneline -1)" && node --no-warnings docs/verification/registry-reads/measure.ts "${3:-300}") > "$here/$run.txt"
  (cd "$tree" && node --test --test-reporter=spec --test-name-pattern="$pattern" "${tests[@]}" 2>&1 | grep -E '^(✔|✖|ℹ (pass|fail))' | grep -v 'failing tests:' | sed -E 's/ \([0-9.]+ms\)$//' | sort -u) > "$here/tests-$run.txt" || true
done

{
  printf '| read | main | branch |\n|---|---:|---:|\n'
  join -t $'\t' <(tail -n +2 "$here/main.txt" | nl -ba -w3 -s $'\t' | sort -t $'\t' -k2,2) <(tail -n +2 "$here/branch.txt" | sort -t $'\t' -k1,1) -1 2 -2 1 \
    | sort -t $'\t' -k2,2n | awk -F '\t' '{ printf "| %s | %s | %s |\n", $1, $3, $4 }'
} | tee "$here/compare.txt"
