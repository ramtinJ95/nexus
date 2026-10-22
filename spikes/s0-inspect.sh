#!/usr/bin/env bash
set -eu
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache"
cd "$HOME/nexus-spikes"
for t in cpio lz4 mke2fs debugfs; do command -v "$t" || true; done
cat node_modules/@earendil-works/gondolin/package.json
cat node_modules/@earendil-works/pi-env/README.md
cat node_modules/@earendil-works/pi-durable/README.md
find node_modules/@earendil-works -iname '*conformance*' -o -iname '*fake*' -o -iname '*execution*'
cat node_modules/@earendil-works/pi-env/dist/index.d.ts
find node_modules/@earendil-works/gondolin -name '*.d.ts' | head -50
