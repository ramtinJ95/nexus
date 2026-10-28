#!/usr/bin/env bash
# Captures what clients see of each agent kind, on main and on this branch, each from its own worktree with this
# directory's copy of the script: the control plane's agent routes, event streams and thread pages, and the nexus CLI.
# Writes main/ and branch/, diff.txt, and the pin tests' runs: on main's code with only the pins added, and on the
# branch.
#
#   docs/verification/thread-agent-kind/run.sh [main-ref] [branch-ref]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
main=${1:-origin/main}
branch=${2:-HEAD}
pins=$(git -C "$repo" log --format=%h -1 --grep '^test(control): pin what each agent kind answers' "$branch")
tests=(src/control/api.test.ts src/control/dashboard.test.ts src/control/review.test.ts src/control/usage-limit.test.ts src/control/pr-watch.test.ts src/control/claude-conversation.test.ts src/cli/nexus.test.ts)
work=$(mktemp -d)
trees=()
trap 'for t in "${trees[@]}"; do git -C "$repo" worktree remove --force "$t" 2>/dev/null; done; rm -rf "$work"' EXIT

checkout() {
  local tree="$work/$1"
  git -C "$repo" worktree add --detach "$tree" "$2" >/dev/null 2>&1
  trees+=("$tree")
  ln -s "$repo/node_modules" "$tree/node_modules"
  (cd "$tree" && node src/control/dashboard/build.ts >/dev/null)
}

for run in main branch; do
  commit=$main
  [ "$run" = branch ] && commit=$branch
  checkout "$run" "$commit"
  tree=$work/$run
  rm -rf "${here:?}/$run"
  mkdir -p "$tree/docs/verification/thread-agent-kind" "$here/$run"
  cp "$here"/*.ts "$tree/docs/verification/thread-agent-kind/"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  # A capture that throws, as on a half-done branch, records its error in its file, so diff.txt shows it.
  if ! (cd "$tree" && node --no-warnings docs/verification/thread-agent-kind/capture-api.ts "$here/$run/api.txt") 2>"$work/$run.err"; then
    { echo "capture-api.ts failed:"; sed "s|$work/$run|<tree>|g" "$work/$run.err"; } >> "$here/$run/api.txt"
  fi
  echo "  api.txt: $(wc -l < "$here/$run/api.txt") lines"
done

diff -u --label main/api.txt --label branch/api.txt "$here/main/api.txt" "$here/branch/api.txt" > "$here/diff.txt" || true
echo "diff.txt: $(grep -c '^[-+][^-+]' "$here/diff.txt" || true) changed lines"

for run in pins branch; do
  tree=$work/branch
  if [ "$run" = pins ]; then
    checkout pins "$pins"
    tree=$work/pins
    # Later test-only commits fix the pins themselves, so they run on main's code too.
    for fix in $(git -C "$repo" log --reverse --format=%h --grep '^test[(:]' "$pins..$branch"); do git -C "$tree" cherry-pick --no-commit "$fix" >/dev/null; done
  fi
  {
    echo "$(git -C "$tree" log --oneline -1)$(git -C "$tree" diff --quiet HEAD || echo ", with the later test-only commits applied")"
    (cd "$tree" && node --test --test-timeout=600000 "${tests[@]}" 2>&1 | grep -E '^(✔|✖|ℹ (tests|pass|fail))' || true)
  } > "$here/tests-$run.txt"
  tail -3 "$here/tests-$run.txt"
done
