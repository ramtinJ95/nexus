#!/usr/bin/env bash
# Captures everything observable about session harnesses, on main and on this branch, each from its own worktree with
# this directory's copy of the scripts: the probe protocol and ingest, the probe's guest calls, and the control plane's
# API, dashboard and CLI. Writes main/ and branch/, diff.txt, and the pin tests' runs: on main's code with only the pins
# added, and on the branch.
#
#   docs/verification/harness-registry/run.sh [main-ref] [branch-ref]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
main=${1:-origin/main}
branch=${2:-HEAD}
pins=$(git -C "$repo" log --format=%h -1 --grep '^test(sessions): pin each harness' "$branch")
captures=(protocol sessions api)
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
  mkdir -p "$tree/docs/verification/harness-registry" "$here/$run"
  cp "$here"/*.ts "$tree/docs/verification/harness-registry/"
  echo "$run: $(git -C "$tree" log --oneline -1)" | tee "$here/$run/commit.txt"
  for name in "${captures[@]}"; do
    # A capture that throws, as on a half-done branch, records its error in its file, so diff.txt shows it.
    if ! (cd "$tree" && node --no-warnings "docs/verification/harness-registry/capture-$name.ts" "$here/$run/$name.txt") 2>"$work/$run-$name.err"; then
      { echo "capture-$name.ts failed:"; sed "s|$work/$run|<tree>|g" "$work/$run-$name.err"; } >> "$here/$run/$name.txt"
    fi
    echo "  $name.txt: $(wc -l < "$here/$run/$name.txt") lines"
  done
done

for name in "${captures[@]}"; do
  diff -u --label "main/$name.txt" --label "branch/$name.txt" "$here/main/$name.txt" "$here/branch/$name.txt" || true
done > "$here/diff.txt"
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
    (cd "$tree" && node --test src/sessions.test.ts src/protocol.test.ts src/reconcile.test.ts src/control/dashboard.test.ts src/cli/nexus.test.ts 2>&1 | grep -E '^(✔|✖|ℹ (tests|pass|fail))' || true)
  } > "$here/tests-$run.txt"
  tail -3 "$here/tests-$run.txt"
done
