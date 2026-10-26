#!/usr/bin/env bash
# One real Claude Code turn whose hooks are this branch's images/pylon files, reporting to stand-in-probe.ts.
# The probe is killed once the turn start is journaled and comes back after the turn has ended, answering its
# first event without an acknowledgement. Writes run.log beside this script.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
work="$(mktemp -d)"
port=7787
export NEXUS_API="http://127.0.0.1:$port"
exec > >(tee "$here/run.log") 2>&1

mkdir -p "$work/bin" "$work/state" "$work/home/.claude" "$work/repo"
cp "$repo"/images/pylon/{nexus-claude-hook,nexus-heartbeat.ts,nexus-outbox.ts,nexus-turn.ts} "$work/bin/"
# The hook snapshots the pylon's checkout on each prompt; this one must not touch the thread's own.
sed -i "s|/home/user/workspace/repo|$work/repo|" "$work/bin/nexus-claude-hook"
git -C "$work/repo" init -q
node -e '
const [bin, path] = process.argv.slice(1);
const hook = (kind) => [{ matcher: "", hooks: [{ type: "command", command: `${bin}/nexus-claude-hook ${kind}`, timeout: 2 }] }];
require("fs").writeFileSync(path, JSON.stringify({ hooks: {
  UserPromptSubmit: hook("session.turn-started"), PostToolUse: hook("session.heartbeat"), Stop: hook("session.turn-ended"), SessionEnd: hook("session.ended"),
} }));' "$work/bin" "$work/home/.claude/settings.json"
outbox="$work/home/.nexus/outbox"

probe() { node "$here/stand-in-probe.ts" "$port" "$work/state" | sed -u 's/^/probe: /' & }
probe
until curl -s -o /dev/null "$NEXUS_API"; do sleep 0.2; done

echo "== a Claude Code turn starts"
(cd "$work/repo" && HOME="$work/home" CLAUDE_CONFIG_DIR="$work/home/.claude" bash -lc \
  'export NEXUS_API='"$NEXUS_API"'; claude -p "Run the shell command \"sleep 20\" with the Bash tool, then reply with the single word done." --dangerously-skip-permissions' \
  | sed -u 's/^/claude: /') &
claude=$!
until grep -q '"kind":"session.turn-started"' "$here/run.log"; do sleep 0.2; done
echo "== killing the probe mid-turn"
pkill -9 -f "stand-in-probe.ts $port"
wait "$claude"
echo "== Claude's turn and session ended; the probe is still down. Outbox:"
ls -1 "$outbox"
echo "sender running: $(pgrep -fc "$work/bin/nexus-outbox.ts" || true)"
sleep 15
echo "== the probe comes back, losing its first acknowledgement"
LOSE_FIRST_ACK=1 probe
until [ -z "$(ls -A "$outbox")" ] && ! pgrep -f "$work/bin/nexus-outbox.ts" >/dev/null; do sleep 0.2; done
echo "== outbox empty, sender exited"
sleep 0.5
pkill -f "stand-in-probe.ts $port"
rm -rf "$work"
