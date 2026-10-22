#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache"
cd "$HOME/nexus-spikes"
export TMPDIR="$PWD/tmp"
mkdir -p "$TMPDIR" logs state
if docker image inspect debian:bookworm-slim >/dev/null 2>&1; then
  echo 'Debian image already exists; do not remove it' | tee state/docker-preexisting.txt
else
  touch state/docker-pulled-by-spike
fi
start=$SECONDS
timeout 1800 node_modules/.bin/gondolin build --config s1-debian.json --output state/debian-assets
echo "BUILD_SECONDS=$((SECONDS-start))"
