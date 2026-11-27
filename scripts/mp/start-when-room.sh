#!/usr/bin/env bash
# Starts each nexus-mp thread in turn, once its builder fits and a review's pylon still fits afterwards. A start that
# takes the last room starves the reviews that are waiting, and a reviewer that waits 30 minutes holds its review for
# the person.
# usage: scripts/mp/start-when-room.sh <title> <brief file> [<title> <brief file>]...
# NEXUS_MP_NODE is the node the project is pinned to and NEXUS_MP_SPILL the other node. A builder takes 8 GiB. It
# starts when the first has 16 GiB uncommitted, or 8 there and 9 on the second. Bounded: 120 tries a thread, one a minute.
set -u
cli() { ${NEXUS_CLI:-nexus} "$@"; }
node_a=${NEXUS_MP_NODE:-infra-testbench}; node_b=${NEXUS_MP_SPILL:-rj-firebat}
cd "${TMPDIR:-/tmp}" || exit 2
spare() {
  cli nodes --json 2>/dev/null \
    | jq -r --arg n "$1" '.[] | select(.name == $n) | .capacity | (.memoryGiB - .committedMemoryGiB) | floor'
}
while [ $# -ge 2 ]; do
  title=$1; brief=$2; shift 2; started=no
  for i in $(seq 1 120); do
    a=$(spare "$node_a"); a=${a:-0}; b=$(spare "$node_b"); b=${b:-0}
    if [ "$a" -ge 16 ] || { [ "$a" -ge 8 ] && [ "$b" -ge 9 ]; }; then
      out=$(cli start --project nexus-mp --title "$title" --claude "$(cat "$brief")" --model claude-opus-5-5 2>&1)
      if grep -q '^Started th-' <<<"$out"; then echo "$out" | head -1; started=yes; break; fi
      if ! grep -qiE 'room|memory' <<<"$out"; then echo "REFUSED for another reason: $out" | cut -c1-600; exit 1; fi
    fi
    sleep 60
  done
  [ "$started" = yes ] || { echo "TIMEOUT: \"$title\" found no room in 120 minutes (last spare: $node_a ${a} GiB, $node_b ${b} GiB)"; exit 1; }
  sleep 90
done
