#!/usr/bin/env bash
# Runs this branch's passkey tests against main's code and against the branch's, and saves each run in
# unit-main.txt and unit-branch.txt here. The tests and their helper come from the branch both times.
#
#   docs/verification/passkey-land/unit.sh [main-commit] [branch-commit]
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$work/main" 2>/dev/null; git -C "$repo" worktree remove --force "$work/branch" 2>/dev/null; rm -rf "$work"' EXIT
tests="src/control/passkeys.test.ts src/control/review.test.ts src/control/api.test.ts src/control/dashboard.test.ts src/cli/nexus.test.ts"
pattern="passkey|Passkeys|waive|waivable|WebAuthn|host command|counter|show prints a review"
for run in main branch; do
  commit=${1:-origin/main}
  [ "$run" = branch ] && commit=${2:-HEAD}
  tree="$work/$run"
  git -C "$repo" worktree add --detach "$tree" "$commit" >/dev/null
  ln -s "$repo/node_modules" "$tree/node_modules"
  for f in $tests src/control/fake-passkey.ts; do git -C "$repo" show "${2:-HEAD}:$f" > "$tree/$f"; done
  (cd "$tree" && npm run build >/dev/null && echo "$run: $(git log --oneline -1), tests from ${2:-HEAD}" && node --test --test-reporter=spec --test-name-pattern="$pattern" $tests 2>&1 | grep -E "^(✔|✖|ℹ (tests|pass|fail))" | sort -u) > "$here/unit-$run.txt"
  cat "$here/unit-$run.txt"
done
