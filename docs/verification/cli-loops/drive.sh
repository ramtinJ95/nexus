#!/usr/bin/env bash
# Drives the checkout's CLI through the SOCKS proxy control.ts runs, and prints each command, its answer, and how
# many CONNECTs the proxy saw for it. Run from the checkout under test with WORK set as control.ts has it.
set -uo pipefail
export HOME="$WORK/home" NEXUS_URL=http://nexus.verify:7470 NEXUS_SOCKS=127.0.0.1:7471
mkdir -p "$HOME"
touch "$WORK/connects"
connects() { wc -l < "$WORK/connects" | tr -d ' '; }
ask() {
  local before; before=$(connects)
  echo "\$ $*"; "$@" 2>&1; echo " (exit $?, $(( $(connects) - before )) CONNECTs)"; echo
}
nexus() { node src/cli/nexus.ts "$@"; }
# Starts `nexus "$@"` under a shell with its output in a file, kills the shell 2 s later, and says how long the orphan lived.
orphan() {
  local out="$WORK/orphan.out" pid start
  : > "$out"
  echo "\$ nexus $* under a shell that is then killed"
  sh -c 'node src/cli/nexus.ts "$@" > "'"$out"'" 2>&1 & echo $!; wait' sh "$@" > "$WORK/orphan.pid" &
  local sh=$!
  until [ -s "$WORK/orphan.pid" ]; do sleep 0.1; done
  sleep 2
  pid=$(cat "$WORK/orphan.pid")
  kill -9 "$sh"; wait "$sh" 2>/dev/null
  start=$(date +%s)
  while kill -0 "$pid" 2>/dev/null && ! grep -q ') Z ' "/proc/$pid/stat" 2>/dev/null; do sleep 0.2; done
  echo " the orphan exited within $(( $(date +%s) - start + 1 )) s"; echo
}

ask nexus --version
ask nexus project add verify --scratch --node verify-node
ask nexus project edit verify --pipeline start
ask nexus item add --project verify --message "Build A" --after ,
ask nexus items --json
ask nexus item add --project verify --message "Build B" --model claude-opus-5-5
thread=$(nexus start --project verify --title watched --json | node -e 'process.stdin.on("data", (d) => console.log(JSON.parse(d).id))')
echo "started $thread"; echo
ask timeout 6 node src/cli/nexus.ts watch "$thread" --interval 250
ask nexus threads
orphan watch "$thread" --interval 60000
orphan events --follow
