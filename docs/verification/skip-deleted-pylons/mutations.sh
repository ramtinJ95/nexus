#!/bin/sh
# Drops each clause that keeps a deleted thread's pylon in the pass, and runs the loop's deleted-thread tests against it.
# Each mutation should fail at least one test. A test that waits for a teardown that never comes ends at the 20 s
# timeout and is counted as cancelled. Restores src/control/registry.ts at the end.
set -u
cd "$(dirname "$0")/../../.."
file=src/control/registry.ts
keep=$(mktemp)
cp "$file" "$keep"
trap 'cp "$keep" "$file"; rm -f "$keep"' EXIT
pattern='deleted|Claude launch|pylon follows'
mutate() {
  cp "$keep" "$file"
  sed -i "$2" "$file"
  if cmp -s "$keep" "$file"; then echo "$1: the mutation did not apply"; exit 1; fi
  echo "## without $1"
  node --test --test-timeout=20000 --test-name-pattern="$pattern" src/control/loop.test.ts 2>&1 | grep -E '^✖ [a-z]' | grep -v '^✖ failing tests:' | sort -u
  echo
}
mutate "the node lists or routes it" 's/ OR p.id IN (SELECT value FROM json_each($present))/ OR (0 AND p.id IN (SELECT value FROM json_each($present)))/'
mutate "a job is sent" 's/ OR p.submitted IS NOT NULL//'
mutate "a preview port is kept" 's/ OR EXISTS (SELECT 1 FROM previews WHERE pylon = p.id)//'
mutate "a Claude launch is starting" "s/ OR EXISTS (SELECT 1 FROM claude_workers WHERE thread = t.id AND state = 'starting')//"
