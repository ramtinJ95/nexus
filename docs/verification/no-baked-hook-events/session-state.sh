#!/usr/bin/env bash
# Lists the per-session state an agent run leaves in a home: hook outbox entries, Claude and pi sessions.
h="$1"
for f in "$h"/.nexus/outbox/*.json; do [ -e "$f" ] && echo "outbox $(basename "$f") $(cat "$f")"; done
for d in .nexus .claude/projects .claude/session-env .pi/agent/sessions .local/share/claude-notes-compaction/sessions; do
  [ -e "$h/$d" ] && find "$h/$d" -mindepth 1 -maxdepth 2 | sed "s|^$h/|state ~/|"
done
pgrep -u "$(stat -c %U "$h")" -fa nexus-outbox | sed 's/^/process /'
echo end
