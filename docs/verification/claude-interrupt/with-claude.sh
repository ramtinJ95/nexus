#!/usr/bin/env bash
# Runs a command beside a real Claude Code (haiku) in pane w1:p1 of a scratch Herdr session, then stops both. Claude
# runs in default permission mode under a fresh session ID, with its own HOME that keeps only Herdr's SessionStart
# hook, so Herdr learns Claude's session IDs and no Nexus hook reports to a control plane. The command gets HOME,
# HERDR_SESSION and SESSION. It needs a pylon whose CLAUDE_CODE_OAUTH_TOKEN works, so run it from a login shell:
#
#   bash -l docs/verification/claude-interrupt/with-claude.sh env OUT=docs/verification/claude-interrupt/live node docs/verification/claude-interrupt/live.ts
set -euo pipefail
# Herdr's socket path must fit in sun_path, so the scratch HOME sits at a short path.
scratch=$(mktemp -d /tmp/nxi.XXXX)
export HOME="$scratch/home" HERDR_SESSION=verify SESSION=$(cat /proc/sys/kernel/random/uuid)
unset HERDR_ENV HERDR_PANE_ID HERDR_SOCKET_PATH
trap 'herdr --session "$HERDR_SESSION" server stop >/dev/null 2>&1 || true; rm -rf "$scratch"' EXIT
mkdir -p "$HOME/.claude/hooks" "$HOME/.config/herdr" "$scratch/work"
work=$(cd "$scratch/work" && pwd -P)
cp /home/user/.config/herdr/config.toml "$HOME/.config/herdr/"
cp /home/user/.claude/hooks/herdr-agent-state.sh "$HOME/.claude/hooks/"
python3 - "$work" <<'EOF'
import json, os, sys
home = os.environ["HOME"]
kept = {k: v for k, v in json.load(open("/home/user/.claude.json")).items() if k in ("hasCompletedOnboarding", "lastOnboardingVersion", "theme", "userID")}
kept["projects"] = {sys.argv[1]: {"hasTrustDialogAccepted": True, "allowedTools": []}}
json.dump(kept, open(f"{home}/.claude.json", "w"))
hook = f"bash '{home}/.claude/hooks/herdr-agent-state.sh' session"
json.dump({"hooks": {"SessionStart": [{"matcher": "^(startup|resume|clear|compact|fork)$", "hooks": [{"type": "command", "command": hook, "timeout": 10}]}]}}, open(f"{home}/.claude/settings.json", "w"))
EOF
setsid -f herdr --session "$HERDR_SESSION" server </dev/null >/dev/null 2>&1
until herdr --session "$HERDR_SESSION" api snapshot >/dev/null 2>&1; do sleep 0.2; done
herdr --session "$HERDR_SESSION" workspace create --cwd "$work" --label "Claude Code" >/dev/null
herdr --session "$HERDR_SESSION" agent start nx-live --kind claude --pane w1:p1 --timeout 60000 -- --session-id "$SESSION" --model haiku --permission-mode default >/dev/null
echo "Claude session $SESSION, $(claude --version)"
"$@"
