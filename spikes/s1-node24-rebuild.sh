#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache" TMPDIR="$HOME/nexus-spikes/tmp"
cd "$HOME/nexus-spikes"
ulimit -c 0
mkdir -p tools
version=v24.22.1
archive="node-$version-linux-x64.tar.xz"
curl -fsSL --connect-timeout 15 --max-time 120 "https://nodejs.org/dist/$version/$archive" -o "tools/$archive"
curl -fsSL --connect-timeout 15 --max-time 30 "https://nodejs.org/dist/$version/SHASUMS256.txt" -o tools/node-SHASUMS256.txt
(cd tools; grep " $archive\$" node-SHASUMS256.txt | sha256sum -c -)
tar -xJf "tools/$archive" -C tools
tools/node-v24.22.1-linux-x64/bin/node --version
# Docker v29 exposes the ID under Actor.ID, unlike the older example template.
docker events --since 30m --until 1s --filter type=container --filter image=debian:bookworm-slim \
  --format '{{.Action}} {{.Actor.ID}}' > logs/s12-docker-events-recovered.txt
docker events --filter type=container --filter image=debian:bookworm-slim \
  --format '{{.Action}} {{.Actor.ID}}' > logs/s12-docker-events-node24.txt 2>&1 &
observer=$!
finish() {
  sleep 1
  kill "$observer" 2>/dev/null || true
  wait "$observer" 2>/dev/null || true
  awk '$1 == "create" { print $2 }' logs/s12-docker-events-recovered.txt logs/s12-docker-events-node24.txt | sort -u > state/s12-created-containers.txt
  echo "CREATED_CONTAINER_IDS=$(wc -l < state/s12-created-containers.txt)"
  docker image inspect debian:bookworm-slim --format '{{.Id}}' > state/s12-pulled-image.txt
}
trap finish EXIT
TIMEFORMAT='BUILD_SECONDS=%3R'
time timeout 1800 tools/node-v24.22.1-linux-x64/bin/node node_modules/@earendil-works/gondolin/dist/bin/gondolin.js build --config s1-debian.json --output state/debian-assets
