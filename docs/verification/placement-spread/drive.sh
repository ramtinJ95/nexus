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
# By now infra-testbench has 15.3 GiB left and spare-node 11.3, so only infra-testbench fits a 12 GiB thread.
{ nexus start --project nexus --title "sized" --memory 12 --cpus 2; echo "exit $?"; } > "$here/start-sized.txt" 2>&1
{ nexus start --project nexus --title "too big" --memory 20; echo "exit $?"; } > "$here/start-too-big.txt" 2>&1
{ nexus project add spread https://github.com/octocat/Hello-World.git; echo "exit $?"; nexus project add spread-json https://github.com/octocat/Hello-World.git --json; nexus projects; } > "$here/project-add.txt" 2>&1

nexus threads --json > "$here/threads.json"
for title in "overlap one" "overlap two" "before the edit" "after the edit" "pinned" "sized"; do
  id=$(node -e 'const ts = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(ts.find((t) => t.title === process.argv[2]).id)' "$here/threads.json" "$title")
  nexus show "$id" | grep -E "^th-|^pylon:|^size:|^placement:"
  echo
done > "$here/show.txt"

# The dashboard's home page as the server renders it, cut to the side node list, the start dialog's hint and size
# fields, and the new-project dialog's node picker.
curl -s -H 'host: 127.0.0.1' "$NEXUS_URL/" | node -e '
  const page = require("fs").readFileSync(0, "utf8");
  const cut = (re) => { const m = re.exec(page); if (m === null) throw new Error(`no ${re}`); return m[0]; };
  console.log([/<div class="nodes" id="side-nodes"[\s\S]*?<\/div>/, /<div class="two three">[\s\S]*?<\/div>\n<\/div>/, /<p class="hint" id="start-hint"[\s\S]*?<\/p>/, /<select id="project-node"[\s\S]*?<\/select>/].map(cut).join("\n"));
' > "$here/dashboard.html"
