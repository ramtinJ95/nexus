#!/usr/bin/env bash
# Builds and smoke-boots the base pylon image on the image build node into ~/nexus-spikes/images/<image ID>,
# through the same buildImage a build-image job runs. Run from the repo checkout on the node, after npm ci:
#   bash images/pylon/build.sh [node name, default infra-testbench]
#
# Caches and scratch stay under ~/nexus-spikes, as for the pylon-test image. Docker: buildImage removes its own
# tag, and this script removes only what the build added besides that: the pinned Debian base if it was absent
# before, and each build cache entry whose ID was not in the before listing, pruned by ID.
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" npm_config_cache="$HOME/nexus-spikes/npm-cache" TMPDIR="$HOME/nexus-spikes/tmp"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
logs="$HOME/nexus-spikes/logs"
artifacts="$HOME/nexus-spikes/images"
base="debian@$(sed -n 's/.*"debianDigest": *"\(sha256:[0-9a-f]*\)".*/\1/p' "$repo/images/pylon/pins.json")"
ulimit -c 0
mkdir -p "$logs" "$TMPDIR" "$artifacts"

base_before=$(docker image inspect --format '{{.Id}}' "$base" 2>/dev/null || true)
cache_ids() { docker buildx du --verbose | sed -n 's/^ID:[[:space:]]*//p' | tr -d '*' | sort -u; }
cache_ids > "$logs/pylon-cache-before.txt"
docker images -q --no-trunc | sort -u > "$logs/pylon-images-before.txt"
echo "BASE_PRESENT_BEFORE=${base_before:+yes} BUILD_CACHE_ENTRIES_BEFORE=$(wc -l < "$logs/pylon-cache-before.txt")"

cleanup() {
  if [ -z "$base_before" ] && docker image inspect "$base" >/dev/null 2>&1; then docker rmi "$base"; fi
  cache_ids > "$logs/pylon-cache-built.txt"
  for id in $(comm -13 "$logs/pylon-cache-before.txt" "$logs/pylon-cache-built.txt"); do
    docker buildx prune --all --force --filter "id=$id"
  done
  docker images -q --no-trunc | sort -u > "$logs/pylon-images-after.txt"
  echo "NEW_IMAGES=$(comm -13 "$logs/pylon-images-before.txt" "$logs/pylon-images-after.txt" | wc -l)"
}
trap cleanup EXIT

cd "$repo"
TIMEFORMAT='BUILD_SECONDS=%3R'
time node src/image-build.ts "${1:-infra-testbench}" "$artifacts"
