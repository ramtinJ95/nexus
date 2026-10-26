#!/bin/sh
# Drives the stack in stack.ts with the real CLI and writes each capture beside this script.
#   node docs/verification/node-capacity/stack.ts & sleep 5; sh docs/verification/node-capacity/drive.sh
set -u
here=$(dirname "$0")
export NEXUS_URL=http://127.0.0.1:7470 NEXUS_SOCKS=none
nexus() { node "$here/../../../src/cli/nexus.ts" "$@"; }

nexus --version > "$here/version.txt"
nexus nodes > "$here/nodes.txt"
nexus nodes --json > "$here/nodes.json"
{ nexus start --project acme --title "default placement"; echo "exit $?"; } > "$here/start-default.txt" 2>&1
{ nexus start --project acme --title "auto placement" --node auto; echo "exit $?"; } > "$here/start-auto.txt" 2>&1
{ nexus start --project huge --title "too big" --node auto; echo "exit $?"; } > "$here/start-refused.txt" 2>&1
nexus threads --json > "$here/threads.json"
for id in $(node -e 'for (const t of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))) console.log(t.id)' "$here/threads.json"); do
  nexus show "$id"
  echo
done > "$here/show.txt"
