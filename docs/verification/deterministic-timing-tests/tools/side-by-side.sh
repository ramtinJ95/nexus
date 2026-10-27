#!/bin/sh
# side-by-side.sh <runs> <cpus> <busy loops> <out dir> <before checkout> <after checkout> <test file> <name pattern>:
# runs one test file's matching tests that many times in each checkout at once, both at nice 10 and pinned with that many busy loops
# to the CPUs `taskset -c <cpus>` names, so the two get the same load. Counts land in <out dir>/{before,after}.txt.
set -u
loop=$(cd "$(dirname "$0")/../../slow-send-and-flake/tools" && pwd)/loop.sh
mkdir -p "$4"
loops=""
for j in $(seq "$3"); do taskset -c "$2" sh -c 'while :; do :; done' & loops="$loops $!"; done
(cd "$5" && taskset -c "$2" nice -n 10 sh "$loop" "$1" "$7" "$8" >"$4/before.txt" 2>&1) & before=$!
(cd "$6" && taskset -c "$2" nice -n 10 sh "$loop" "$1" "$7" "$8" >"$4/after.txt" 2>&1) & after=$!
wait $before $after
[ -z "$loops" ] || kill $loops
