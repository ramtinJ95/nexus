#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache" TMPDIR="$HOME/nexus-spikes/tmp"
cd "$HOME/nexus-spikes"
ulimit -c 0
node s1-supported-variants.mjs
