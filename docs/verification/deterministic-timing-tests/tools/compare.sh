#!/bin/sh
# compare.sh <rounds> <cpus> <busy loops> <out dir> <before checkout> <after checkout>: each round runs the full suite
# (npm test's files) in both checkouts at once, beside that many busy loops, all pinned to the CPUs `taskset -c <cpus>`
# names, so both suites get the same load. NODE_OPTIONS and the preloads' variables pass through to every test
# process. Writes each suite's log and failing tests to <out dir>/<round>-{before,after}.{log,txt}.
set -u
mkdir -p "$4"
for i in $(seq "$1"); do
  loops=""
  for j in $(seq "$3"); do taskset -c "$2" sh -c 'while :; do :; done' & loops="$loops $!"; done
  start=$(date +%s)
  suites=""
  for side in before after; do
    dir=$5; [ "$side" = after ] && dir=$6
    (cd "$dir" && files=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("package.json")).scripts.test.replace(/^node --test /, ""))') \
      && taskset -c "$2" node --test $files >"$4/$i-$side.log" 2>&1; echo "round $i $side: seconds=$(( $(date +%s) - start )) $(grep -E '^ℹ (pass|fail) ' "$4/$i-$side.log" | tr '\n' ' ')") & suites="$suites $!"
  done
  wait $suites
  [ -z "$loops" ] || kill $loops
  for side in before after; do
    sed -n '/^✖ failing tests:/,$p' "$4/$i-$side.log" | grep -E '^\s*✖ ' | grep -v 'failing tests:' | sed -E 's/ \([0-9.]+m?s\)$//; s/^\s+//' | sort -u >"$4/$i-$side.txt"
  done
done
