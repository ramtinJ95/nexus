#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache"
cd "$HOME/nexus-spikes"
tailscale serve status > logs/s4-status-before.txt 2>&1
cat logs/s4-status-before.txt
tailscale serve status --json > logs/s4-status-before.json
