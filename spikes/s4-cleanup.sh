#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache"
cd "$HOME/nexus-spikes"
if [ -f state/s4-serve-enabled ]; then
  tailscale serve --https=8443 off
fi
tailscale serve status > logs/s4-status-final.txt 2>&1
tailscale serve status --json > logs/s4-status-final.json
cat logs/s4-status-final.txt
diff -u logs/s4-status-before.txt logs/s4-status-final.txt
diff -u logs/s4-status-before.json logs/s4-status-final.json
touch state/s4-stop
echo 'SERVE_CONFIG_RESTORED=true'
