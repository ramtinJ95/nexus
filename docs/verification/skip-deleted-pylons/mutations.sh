#!/bin/sh
# Drops each clause that keeps a deleted thread's pylon in the pass, and each guard on a Claude reader's release, and
# runs the tests that pin them. Each mutation should fail at least one test. A test that waits for something that
# never comes ends at the 20 s timeout and is counted as cancelled. Restores the mutated files at the end.
set -u
cd "$(dirname "$0")/../../.."
keep=$(mktemp -d)
cp src/control/registry.ts src/control/claude-conversation.ts "$keep"
trap 'cp "$keep/registry.ts" src/control/registry.ts; cp "$keep/claude-conversation.ts" src/control/claude-conversation.ts; rm -rf "$keep"' EXIT
mutate() {
  file=src/control/$2
  cp "$keep/$2" "$file"
  sed -i "$3" "$file"
  if cmp -s "$keep/$2" "$file"; then echo "$1: the mutation did not apply"; exit 1; fi
  echo "## without $1"
  node --no-warnings --test --test-timeout=20000 --test-name-pattern="$5" "$4" 2>&1 | grep -E '^✖ [a-z]' | grep -v '^✖ failing tests:' | sort -u
  cp "$keep/$2" "$file"
  echo
}
loop='deleted|Claude launch|pylon follows'
mutate "the node lists or routes it" registry.ts 's/ OR p.id IN (SELECT value FROM json_each($present))/ OR (0 AND p.id IN (SELECT value FROM json_each($present)))/' src/control/loop.test.ts "$loop"
mutate "a job is sent" registry.ts 's/ OR p.submitted IS NOT NULL//' src/control/loop.test.ts "$loop"
mutate "a preview port is kept" registry.ts 's/ OR EXISTS (SELECT 1 FROM previews WHERE pylon = p.id)//' src/control/loop.test.ts "$loop"
mutate "a retry is pending" registry.ts 's/ OR p.retrying = 1//' src/control/loop.test.ts "$loop"
mutate "a Claude launch is starting" registry.ts "s/ OR EXISTS (SELECT 1 FROM claude_workers WHERE thread = t.id AND state = 'starting')//" src/control/loop.test.ts "$loop"
mutate "the reader release's check that the service is open" claude-conversation.ts 's/    if (!closed \&\& r.reading === null/    if (r.reading === null/' src/control/claude-conversation.test.ts .
mutate "the reader release's check that nothing watches" claude-conversation.ts 's/ \&\& r.watchers.size === 0 \&\& registry/ \&\& registry/' src/control/claude-conversation.test.ts .
mutate "the release after a read" claude-conversation.ts 's/^          release(id, r);/          void release;/' src/control/claude-conversation.test.ts .
mutate "the release after a watch" claude-conversation.ts 's/^            release(t.id, r);/            void release;/' src/control/claude-conversation.test.ts .
