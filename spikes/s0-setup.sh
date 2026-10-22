#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache"
cd "$HOME/nexus-spikes"
mkdir -p state logs
test -f package.json || npm init -y
npm install --save-exact @earendil-works/gondolin@0.13 @earendil-works/pi-durable@latest @earendil-works/pi-env@latest
npm ls --depth=0
printf '\n--- Gondolin files ---\n'
find node_modules/@earendil-works/gondolin -maxdepth 2 -type f | head -60
printf '\n--- Env and durable files ---\n'
find node_modules/@earendil-works/pi-env node_modules/@earendil-works/pi-durable -maxdepth 2 -type f | head -100
