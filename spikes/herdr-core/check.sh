#!/usr/bin/env bash
# Settles what Nexus needs to know about Herdr Core before its pylon sessions move onto it. Runs against an isolated
# core (HC_SESSION=nexus-checks), so the person's own terminals and herdr-app are untouched. Claude Code runs on the
# person's own login with Haiku, a few short prompts. Each check prints one RESULT line; evidence goes to $out.
# Usage: spikes/herdr-core/check.sh [stack-thread]   (with a thread, also checks the core inside that pylon)
set -u
# A clean environment, as in a pylon: a Claude Code session that runs this would otherwise hand its own session
# variables to the Claude under test, which then keeps no transcript of its own.
[ -n "${NEXUS_CHECK_CLEAN:-}" ] || exec env -i NEXUS_CHECK_CLEAN=1 HOME="$HOME" USER="$USER" PATH="$PATH" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" TERM=xterm-256color LANG=C.UTF-8 OUT="${OUT:-}" bash "$0" "$@"
unset HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SCOPE
export HC_SESSION=nexus-checks
hc=herdr-core
out=${OUT:-}
out=${out:-/tmp/nexus-core-checks}
work=$out/work
rm -rf "$out" && mkdir -p "$work"
claude=$(mise which claude 2>/dev/null || command -v claude)
pi=$(command -v pi)
slug=$(printf '%s' "$work" | tr '/.' '--')
results=$out/results.txt

result() { printf 'RESULT %-22s %-9s %s\n' "$1" "$2" "$3" | tee -a "$results"; }
get() { $hc get "$1" --json; }
field() { get "$1" | jq -c "$2"; }
user_messages() { jq -r 'select(.type=="user" and (.message.content|type)=="string") | .message.content' "$HOME/.claude/projects/$slug/$1.jsonl" 2>/dev/null; }
user_count() { jq -s '[.[] | select(.type=="user" and (.message.content|type)=="string")] | length' "$HOME/.claude/projects/$slug/$1.jsonl" 2>/dev/null; }
until_status() { # terminal, jq predicate on .status, seconds
  local i
  for ((i = 0; i < $3 * 5; i++)); do get "$1" | jq -e "$2" >/dev/null && return 0; sleep 0.2; done
  return 1
}

$hc server start >/dev/null 2>&1

# argv with a newline reaches the program as one argument, so a prompted launch needs no typed shell line.
$hc run --bg --no-parent --name argv --cwd "$work" -- printf '[%s]' $'line one\nline two' >/dev/null
sleep 0.5
$hc read argv > "$out/argv.txt"
if rg -U -q '\[line one\s*\nline two\]' "$out/argv.txt"; then result argv-newline PASS "one argument kept its newline"; else result argv-newline FAIL "$(head -c 200 "$out/argv.txt")"; fi

# Claude with a chosen session ID, prompted at launch with a two-line prompt, in a folder it has never trusted.
sid=$(cat /proc/sys/kernel/random/uuid)
$hc run --bg --no-parent --keep --name claude --cwd "$work" --label nexus.harness=claude-code -- \
  env HOME="$HOME" PATH="$(dirname "$claude"):/usr/bin:/bin" "$claude" --model haiku --session-id "$sid" $'First line.\nSecond line: reply with exactly LAUNCH-OK' >/dev/null
$hc wait claude --output 'trust' --timeout 30 >/dev/null 2>&1
result trust-status OBSERVED "status at the trust dialog: $(field claude .status)"
for _ in $(seq 1 50); do
  $hc read claude | rg -q '❯ Yes, I trust' && break
  $hc keys claude down >/dev/null; sleep 0.3
done
$hc keys claude enter >/dev/null
if until_status claude '(.status.state=="idle" or .status.state=="done") and .turn>=1' 90; then
  launched=$(jq -rs 'map(select(.type=="user" and (.message.content|type)=="string") | .message.content) | first' "$HOME/.claude/projects/$slug/$sid.jsonl")
  if [ "$launched" = $'First line.\nSecond line: reply with exactly LAUNCH-OK' ]; then result prompted-launch PASS "the two-line prompt was the first user message"; else result prompted-launch FAIL "first user message: $(printf '%q' "$launched")"; fi
else
  result prompted-launch FAIL "never idle after a turn: $(field claude '{status,turn}')"
fi
result session-label OBSERVED "labels: $(field claude .labels)"

send_check() { # name, text
  local before after got
  before=$(user_count "$sid")
  $hc send claude "$2" --wait --timeout 120 --json > "$out/$1.send.json" 2>&1
  after=$(user_count "$sid")
  got=$(jq -rs 'map(select(.type=="user" and (.message.content|type)=="string") | .message.content) | last' "$HOME/.claude/projects/$slug/$sid.jsonl")
  if [ "$got" = "$2" ]; then result "$1" PASS "submitted as written, $((after - before)) new user message(s)"; else result "$1" FAIL "last user message: $(printf '%q' "${got:0:160}")"; fi
}
send_check send-multiline $'Line A of a message.\nLine B of it.\nReply with exactly MULTI-OK'
send_check send-slash '/tmp/somewhere is only a path, not a command. Reply with exactly SLASH-OK'
long=$(printf 'filler %.0s' $(seq 1 600))
send_check send-long "${long}Reply with exactly LONG-OK"

# A `!`-leading message: Claude's bash mode, or a message?
$hc send claude '!echo BANG-RAN-$((40+2))' --wait --timeout 60 --json > "$out/bang.json" 2>&1
$hc read claude > "$out/bang.screen"
if rg -q 'BANG-RAN-42' "$out/bang.screen"; then result send-bang OBSERVED "ran as Claude's bash mode"; else result send-bang OBSERVED "did not run as bash: $(user_messages "$sid" | tail -1 | head -c 120)"; fi

# Esc stops a turn and leaves Claude running.
$hc send claude 'Write the numbers from 1 to 400, one per line, with no other text.' --json >/dev/null 2>&1
if until_status claude '.status.state=="working"' 30; then
  sleep 2
  $hc keys claude esc >/dev/null
  if until_status claude '.status.state!="working"' 30 && [ "$(field claude .state)" = '"live"' ]; then result esc-interrupt PASS "stopped working and still live after Esc: $(field claude .status)"; else result esc-interrupt FAIL "$(field claude '{state,status}')"; fi
else
  result esc-interrupt FAIL "never working: $(field claude .status)"
fi

# --if idle refuses while Claude works, so a send never lands mid-turn by accident.
$hc send claude 'Write the numbers from 1 to 300, one per line, with no other text.' --json >/dev/null 2>&1
until_status claude '.status.state=="working"' 30
$hc send claude 'should not land' --if idle --json > "$out/if-idle.json" 2>&1
result send-if-idle OBSERVED "exit $? $(head -c 200 "$out/if-idle.json")"
$hc keys claude esc >/dev/null; until_status claude '.status.state!="working"' 30

# pi's status in a core terminal.
$hc run --bg --no-parent --name pi --cwd "$work" -- env HOME="$HOME" PATH="$(dirname "$pi"):/usr/bin:/bin" "$pi" >/dev/null
sleep 8
result pi-status OBSERVED "after start: $(field pi '{status,reported,state}')"
$hc send pi 'Reply with exactly PI-OK' --wait --timeout 120 --json > "$out/pi.json" 2>&1
result pi-turn OBSERVED "after a turn: $(field pi '{status,turn}') send: $(head -c 160 "$out/pi.json")"
$hc kill pi >/dev/null 2>&1

# An attached viewer: how its detach key ends it, and whether events show it.
$hc run --bg --no-parent --keep --name target --cwd "$work" --label nexus.title=shell -- bash >/dev/null
( timeout 6 $hc events --json > "$out/events.jsonl" 2>&1 & )
sleep 0.5
$hc run --bg --no-parent --name viewer -- $hc attach target >/dev/null
sleep 1.5
$hc keys viewer 'ctrl+\' >/dev/null
sleep 1.5
result attach-detach OBSERVED "viewer after ctrl+\\: $(field viewer '{state,exit_code,reason}')"
sleep 4
result attach-events OBSERVED "event kinds while attached: $(jq -r '.kind // .type // .event // keys[0]' "$out/events.jsonl" 2>/dev/null | sort | uniq -c | tr -s ' \n' ' ')"

# Addresses after rm, and kept terminals and labels across a core stop and start.
first=$($hc run --bg --no-parent --json --name gone -- true | jq -r .address); sleep 0.5; $hc rm gone >/dev/null 2>&1
second=$($hc run --bg --no-parent --json --name again -- true | jq -r .address)
if [ "$first" != "$second" ]; then result address-reuse PASS "$first removed, next is $second"; else result address-reuse FAIL "$first was reused"; fi
target=$(field target .address)
$hc server stop >/dev/null 2>&1; $hc server start >/dev/null 2>&1; sleep 1
result restart-kept OBSERVED "target $target after stop/start: $(field target '{address,state,keep,labels,argv}')"
result restart-claude OBSERVED "claude after stop/start: $(field claude '{address,state,keep,labels,argv:.foreground.argv}')"

# Inside a pylon of the verify stack, with nothing else connected to its core. A pylon has no systemd user manager,
# and hc says its core then ends with whatever started it, so the first exec's core is checked against one started
# detached, as Nexus starts Herdr's server today.
if [ -n "${1:-}" ]; then
  export NEXUS_URL=http://127.0.0.1:7470 NEXUS_SOCKS=none
  nexus=(node "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/src/cli/nexus.ts")
  pexec() { "${nexus[@]}" exec "$1" "$2"; }
  pexec "$1" 'herdr-core server stop >/dev/null 2>&1; herdr-core run --bg --no-parent --keep --name persist -- sleep 10000 >/dev/null 2>&1; echo started' > "$out/pylon-start.txt" 2>&1
  sleep 2
  pexec "$1" 'herdr-core get persist --json' > "$out/pylon-get.json" 2>&1
  if jq -e '.state=="live"' "$out/pylon-get.json" >/dev/null 2>&1; then result pylon-core-by-exec PASS "a later exec found it live"; else result pylon-core-by-exec OBSERVED "gone once its exec ended: $(head -c 160 "$out/pylon-get.json")"; fi
  pexec "$1" 'herdr-core server stop >/dev/null 2>&1; setsid -f herdr-core serve </dev/null >/tmp/hc-serve.log 2>&1; sleep 1; herdr-core run --bg --no-parent --keep --name persist -- sleep 10000 >/dev/null 2>&1; echo started' > "$out/pylon-start-detached.txt" 2>&1
  sleep 2
  pexec "$1" 'herdr-core get persist --json; echo; herdr-core server status --json' > "$out/pylon-get-detached.json" 2>&1
  if head -1 "$out/pylon-get-detached.json" | jq -e '.state=="live"' >/dev/null 2>&1; then result pylon-core-detached PASS "a core started with setsid outlived its exec"; else result pylon-core-detached FAIL "$(head -c 200 "$out/pylon-get-detached.json")"; fi
  pexec "$1" 'herdr-core kill persist; herdr-core rm persist' >/dev/null 2>&1
fi

$hc kill claude >/dev/null 2>&1
$hc server stop >/dev/null 2>&1
echo "evidence in $out"
