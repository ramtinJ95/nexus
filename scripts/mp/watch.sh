#!/usr/bin/env bash
# Waits on Nexus threads and says why it stopped waiting.
# usage: [SKIP_HEAD=<short sha>] scripts/mp/watch.sh <thread>...
# Exits when a thread's review reaches an end state (one that still names SKIP_HEAD is an old result and is skipped),
# a thread asks a question that is not a holds question, a thread stops being active, a thread sits idle with no
# review running for 10 polls in a row (a builder that stopped to report), or a pull request merges into main.
# Bounded: 90 polls of 60 s. NEXUS_CLI names the CLI when `nexus` is not on PATH, such as "node <clone>/src/cli/nexus.ts".
set -u
cli() { ${NEXUS_CLI:-nexus} "$@"; }
repo=${NEXUS_GH_REPO:-ramtinJ95/nexus}
cd "${TMPDIR:-/tmp}" || exit 2
skip=${SKIP_HEAD:-}
last_main=$(gh pr list --repo "$repo" --state merged --base main --limit 1 --json number -q '.[0].number')
declare -A idle
why=""
for i in $(seq 1 90); do
  for t in "$@"; do
    out=$(cli show "$t" 2>&1) || { why="show failed for $t"; break 2; }
    st=$(sed -n 's/^status: //p' <<<"$out")
    case "$st" in active*) ;; *) why="$t status: $st"; break 2;; esac
    rv=$(sed -n 's/^review [^:]*: \([^,]*\),.*/\1/p' <<<"$out" | head -1)
    running=0
    case "$rv" in
      "") ;;
      reviewing|fixing|checking|verifying|quoting|merging|deploying) running=1 ;;
      *) if [ -n "$skip" ] && grep -q "at $skip" <<<"$out"; then :; else why="$t review: $rv"; break 2; fi ;;
    esac
    q=$(grep '^question ' <<<"$out" | grep -v '^question holds-' | head -1)
    if [ -n "$q" ]; then why="$t asks: $q"; break 2; fi
    if [ "$running" = 0 ] && [ "$st" = "active" ]; then
      idle[$t]=$(( ${idle[$t]:-0} + 1 ))
      if [ "${idle[$t]}" -ge 10 ]; then why="$t idle for 10 minutes with no review running"; break 2; fi
    else
      idle[$t]=0
    fi
  done
  now_main=$(gh pr list --repo "$repo" --state merged --base main --limit 1 --json number -q '.[0].number')
  [ "$now_main" != "$last_main" ] && { why="PR #$now_main merged into main"; break; }
  sleep 60
done
echo "WHY: ${why:-timeout after 90 minutes}"
for t in "$@"; do cli show "$t" 2>&1 | grep -E '^(th-|attention|status|review|PR|question|session|live check)' | cut -c1-400; echo; done
gh pr list --repo "$repo" --state open --json number,title,baseRefName,headRefName,headRefOid -q '.[] | "#\(.number) base=\(.baseRefName) head=\(.headRefName) \(.headRefOid[0:12]) \(.title)"'
