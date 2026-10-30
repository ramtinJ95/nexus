#!/bin/sh
# Types three messages into a real Claude Code session the way the probe's send-claude does (src/sessions.ts:
# 64-code-point chunks through `herdr pane send-text`, then Enter): one while Claude is idle, one that starts a turn
# of five tool calls, and one typed during that turn, which Claude takes mid-turn as a queued_command attachment.
# check.ts then finds each typed text among the transcript's prompts by SHA-256, as promptSenders does.
# Run it from a Herdr pane with Claude Code signed in: docs/verification/claude-prompt-senders/run.sh
set -eu
test "${HERDR_ENV:-}" = 1 || { echo "run this inside a Herdr pane"; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
session=$(cat /proc/sys/kernel/random/uuid)
pane=$(herdr pane split --current --direction right --cwd "$work" --no-focus | node -e 'process.stdin.on("data", (d) => console.log(JSON.parse(d).result.pane.pane_id))')
trap 'herdr pane close "$pane" >/dev/null 2>&1 || true' EXIT
herdr agent start prompt-senders --kind claude --pane "$pane" --timeout 60000 -- --session-id "$session" --dangerously-skip-permissions --model claude-haiku-5-5 >/dev/null 2>&1 || true
# The folder trust dialog: pick "Yes, I trust this folder".
herdr pane send-keys "$pane" Down; sleep 0.3; herdr pane send-keys "$pane" Enter; sleep 6
node "$here/type.ts" "$pane" review "$work/review.txt"
sleep 3; herdr agent wait prompt-senders --timeout 120000 >/dev/null
node "$here/type.ts" "$pane" busy "$work/busy.txt"
sleep 5
herdr agent get prompt-senders | grep -o '"agent_status":"[a-z]*"'
node "$here/type.ts" "$pane" nudge "$work/nudge.txt"
sleep 30; herdr agent wait prompt-senders --timeout 180000 >/dev/null
transcript=$(find "$HOME/.claude/projects" -name "$session.jsonl")
node "$here/check.ts" "$transcript" "$work" | tee "$here/check.txt"
