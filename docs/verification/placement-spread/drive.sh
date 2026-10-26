#!/bin/sh
# Drives the stack in stack.ts with the real CLI and writes each capture beside this script.
#   node docs/verification/placement-spread/stack.ts & sleep 5; sh docs/verification/placement-spread/drive.sh
set -u
here=$(dirname "$0")
export NEXUS_URL=http://127.0.0.1:7471 NEXUS_SOCKS=none
nexus() { node "$here/../../../src/cli/nexus.ts" "$@"; }

nexus --version > "$here/version.txt"
nexus nodes > "$here/nodes.txt"
nexus nodes --json > "$here/nodes.json"

# Two harness starts at once. Each waits 2 s for its conversation between choosing a node and writing its row.
nexus start --project nexus --title "overlap one" --node auto --json > "$here/overlap-one.json" &
nexus start --project nexus --title "overlap two" --node auto --json > "$here/overlap-two.json" &
wait
for f in overlap-one overlap-two; do node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(`${t.title}: ${t.placement.how} chose ${t.placement.node}; ${t.placement.weighed.map((w) => w.refused ? `${w.node} ${w.refused}` : `${w.node} had ${w.left.memoryGiB} GiB left`).join("; ")}`)' "$here/$f.json"; done > "$here/overlap.txt"

{ nexus start --project nexus --title "before the edit"; echo "exit $?"; } > "$here/start-default.txt" 2>&1
{ nexus project edit nexus --node auto; echo "exit $?"; nexus projects; } > "$here/project-edit.txt" 2>&1
{ nexus start --project nexus --title "after the edit"; echo "exit $?"; } > "$here/start-project-auto.txt" 2>&1
{ nexus start --project nexus --title "pinned" --node spare-node; echo "exit $?"; } > "$here/start-pinned.txt" 2>&1
{ nexus project add spread https://github.com/octocat/Hello-World.git; echo "exit $?"; nexus project add spread-json https://github.com/octocat/Hello-World.git --json; nexus projects; } > "$here/project-add.txt" 2>&1

nexus threads --json > "$here/threads.json"
for title in "overlap one" "overlap two" "before the edit" "after the edit" "pinned"; do
  id=$(node -e 'const ts = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(ts.find((t) => t.title === process.argv[2]).id)' "$here/threads.json" "$title")
  nexus show "$id" | grep -E "^th-|^pylon:|^placement:"
  echo
done > "$here/show.txt"
