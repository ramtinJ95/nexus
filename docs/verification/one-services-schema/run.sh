#!/bin/sh
# Reruns the evidence: compare.ts and the agreement tests on main and on this branch, captured the same way.
# Usage: docs/verification/one-services-schema/run.sh [main-ref]   (default origin/main)
set -u
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
main=${1:-origin/main}
tree=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$tree" >/dev/null 2>&1; rm -rf "$tree"' EXIT

git -C "$repo" worktree add --detach --quiet "$tree" "$main"
ln -s "$repo/node_modules" "$tree/node_modules"
mkdir -p "$tree/docs/verification/one-services-schema"
cp "$here/compare.ts" "$tree/docs/verification/one-services-schema/"
cp "$repo/src/project.test.ts" "$tree/src/project.test.ts"

capture() { # label dir out
  {
    echo "\$ git rev-parse --short HEAD   # $1"
    git -C "$2" rev-parse --short HEAD
    echo "\$ node docs/verification/one-services-schema/compare.ts"
    (cd "$2" && node docs/verification/one-services-schema/compare.ts)
    echo "exit code: $?"
  } > "$here/$3.txt" 2>&1
  {
    echo "\$ node --test --test-name-pattern 'accept exactly the same' src/project.test.ts   # $1, this branch's test file"
    (cd "$2" && node --test --test-name-pattern 'accept exactly the same' src/project.test.ts)
    echo "exit code: $?"
  } > "$here/$3-test.txt" 2>&1
}
capture main "$tree" main
capture branch "$repo" branch

if test -e /etc/profile.d/nexus.sh; then
  {
    echo "# What a pylon's service script does with env from services.yaml (src/pylon-vm/guest.ts startService):"
    echo "# export each env name, then run the command in a login shell."
    echo "\$ sh -c \"export NEXUS_THREAD_ID=from-services-yaml NEXUS_FOO=from-services-yaml; /bin/sh -lc 'env | grep -E ^NEXUS_\(THREAD_ID\|FOO\)= | sort'\""
    env -i PATH=/usr/bin:/bin sh -c "export NEXUS_THREAD_ID=from-services-yaml NEXUS_FOO=from-services-yaml; /bin/sh -lc 'env | grep -E ^NEXUS_\(THREAD_ID\|FOO\)= | sort'"
  } > "$here/login-shell.txt" 2>&1
fi
tail -n 2 "$here/main.txt" "$here/branch.txt"
grep -h -E '^ℹ (pass|fail)|exit code' "$here/main-test.txt" "$here/branch-test.txt"
