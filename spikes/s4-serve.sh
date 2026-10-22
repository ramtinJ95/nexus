#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache"
cd "$HOME/nexus-spikes"
test -f state/s4-ready
# Refuse to overwrite any preexisting listener on the chosen port.
if grep -q '8443' logs/s4-status-before.json; then
  echo 'STOP: port 8443 already present in original Serve config'
  exit 1
fi
start=$SECONDS
set +e
timeout 30 tailscale serve --bg --https=8443 http://127.0.0.1:18080 > logs/s4-serve.txt 2>&1
rc=$?
set -e
cat logs/s4-serve.txt
echo "SERVE_EXIT=$rc SERVE_SECONDS=$((SECONDS-start))"
tailscale serve status > logs/s4-status-after-attempt.txt 2>&1
cat logs/s4-status-after-attempt.txt
if [ "$rc" -ne 0 ]; then
  touch state/s4-stop
  exit "$rc"
fi
touch state/s4-serve-enabled
