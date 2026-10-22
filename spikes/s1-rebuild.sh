#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache" TMPDIR="$HOME/nexus-spikes/tmp"
cd "$HOME/nexus-spikes"
mkdir -p logs state tmp
id -nG
docker version --format '{{.Server.Version}}'
docker images --no-trunc --format '{{.ID}}' > logs/s12-images-before.txt
docker ps -a --no-trunc --format '{{.ID}}' > logs/s12-containers-before.txt
echo "IMAGES_BEFORE=$(wc -l < logs/s12-images-before.txt) CONTAINERS_BEFORE=$(wc -l < logs/s12-containers-before.txt)"
if docker image inspect debian:bookworm-slim >/dev/null 2>&1; then
  echo 'STOP: Debian image already exists; cannot remove a preexisting image at cleanup.'
  exit 1
fi
docker events --filter type=container --filter image=debian:bookworm-slim \
  --format '{{.Action}} {{.ID}}' > logs/s12-docker-events.txt 2>&1 &
observer=$!
finish() {
  sleep 1
  kill "$observer" 2>/dev/null || true
  wait "$observer" 2>/dev/null || true
  awk '$1 == "create" { print $2 }' logs/s12-docker-events.txt | sort -u > state/s12-created-containers.txt
  echo "CREATED_CONTAINER_IDS=$(wc -l < state/s12-created-containers.txt)"
}
trap finish EXIT
TIMEFORMAT='BUILD_SECONDS=%3R'
time timeout 1800 node_modules/.bin/gondolin build --config s1-debian.json --output state/debian-assets
docker image inspect debian:bookworm-slim --format '{{.Id}}' > state/s12-pulled-image.txt
