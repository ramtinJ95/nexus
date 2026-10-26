#!/bin/sh
# Runs `node verify-wakes.ts <label>` as `user` in a private mount namespace whose /home/user is a scratch
# home, so its `herdr --session nexus` server, sessions file and Claude state are its own and the pylon's
# Herdr server, where this session runs, is never touched. Needs passwordless sudo.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
scratch=${SCRATCH:-$(mktemp -d)}
fake=$scratch/home
rm -rf "$fake" && mkdir -p "$fake/.config/herdr" "$fake/.claude/hooks" "$fake/workspace/repo" "$fake/nexus"
cp /home/user/.config/herdr/config.toml "$fake/.config/herdr/"
cp /home/user/.claude/hooks/herdr-agent-state.sh "$fake/.claude/hooks/"
# Only Herdr's SessionStart hook, as the image installs it, so nothing reports to the control plane.
node -e 'const s=require("/home/user/.claude/settings.json"); console.log(JSON.stringify({hooks:{SessionStart:s.hooks.SessionStart}}))' > "$fake/.claude/settings.json"
git -C "$fake/workspace/repo" init -q && git -C "$fake/workspace/repo" commit -q --allow-empty -m init
cp -r "$repo/src" "$repo/package.json" "$fake/nexus/"
cp "$here/verify-wakes.ts" "$fake/nexus/"
. /etc/profile.d/nexus-secrets.sh
exec sudo --preserve-env=CLAUDE_CODE_OAUTH_TOKEN unshare -m --propagation private sh -c '
  mount --bind "$1" /home/user
  exec setpriv --reuid=user --regid=user --init-groups env -i HOME=/home/user USER=user SHELL=/bin/bash PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" node /home/user/nexus/verify-wakes.ts "$2"
' sandbox "$fake" "${1:-run}"
