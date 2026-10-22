#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache"
cd "$HOME/nexus-spikes"
curl --connect-timeout 30 --max-time 45 -v -D- \
  -w '\nHTTP_STATUS=%{http_code} TOTAL_SECONDS=%{time_total}\n' \
  https://infra-testbench.example.ts.net:8443/
