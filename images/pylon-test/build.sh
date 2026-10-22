#!/usr/bin/env bash
# Builds the pylon-vm slice test image on infra-testbench into ~/nexus-spikes/pylon-test-assets.
# Run from anywhere on the node, after npm ci in this checkout: bash images/pylon-test/build.sh
#
# Kernel modules use the module-seed workaround from spikes/s1-module-seed.sh unchanged: the same seed,
# the same postBuild.copy, the same Node 24 and Gondolin 0.13.0 under ~/nexus-spikes. Gondolin resolves
# postBuild.copy against the config file's directory, so the config is written here with the seed's
# absolute path. Its init.rootfsInitExtra is the base image's own rootfs-init-extra.sh, which sets the
# hostname. Gondolin builds into $out.partial, restore-modes.ts runs buildImage's mode fix on that with this
# checkout's Node and debugfs while the tag still exists, and only then is it renamed to $out.
# Docker: inventories before and after, everything created carries nexus.pylon-test=slice, and only what
# this script created is removed: debian:bookworm-slim if it was absent before, and each build cache entry
# whose ID was not in the before listing, pruned by ID.
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" npm_config_cache="$HOME/nexus-spikes/npm-cache" TMPDIR="$HOME/nexus-spikes/tmp"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
spikes="$HOME/nexus-spikes"
seed="$spikes/state/kernel-module-seed"
out="$spikes/pylon-test-assets"
partial="$out.partial"
logs="$spikes/logs"
tag=nexus-pylon-test:slice
label=nexus.pylon-test=slice
base=debian:bookworm-slim
ulimit -c 0

test ! -e "$out" || { echo "$out already exists. Remove it to rebuild"; exit 1; }
test "$(readlink "$seed/6.18.58-0-virt/vmlinuz")" = /boot/vmlinuz-virt
mkdir -p "$logs" "$TMPDIR"
rm -rf "$partial"

docker images -q --no-trunc | sort -u > "$logs/pylon-test-images-before.txt"
docker ps -a -q --no-trunc | sort -u > "$logs/pylon-test-containers-before.txt"
base_before=$(docker images -q "$base")
cache_ids() { docker buildx du --verbose | sed -n 's/^ID:[[:space:]]*//p' | tr -d '*' | sort -u; }
cache_ids > "$logs/pylon-test-cache-before.txt"
echo "BASE_PRESENT_BEFORE=${base_before:+yes} BUILD_CACHE_ENTRIES_BEFORE=$(wc -l < "$logs/pylon-test-cache-before.txt")"

cleanup() {
  local ids
  ids=$(docker ps -a -q --no-trunc --filter "label=$label")
  if [ -n "$ids" ]; then docker rm --force $ids; fi
  if [ -n "$(docker images -q "$tag")" ]; then docker rmi "$tag"; fi
  if [ -z "$base_before" ] && [ -n "$(docker images -q "$base")" ]; then docker rmi "$base"; fi
  cache_ids > "$logs/pylon-test-cache-built.txt"
  for id in $(comm -13 "$logs/pylon-test-cache-before.txt" "$logs/pylon-test-cache-built.txt"); do
    docker buildx prune --all --force --filter "id=$id"
  done
  cache_ids > "$logs/pylon-test-cache-after.txt"
  echo "NEW_CACHE_ENTRIES_LEFT=$(comm -13 "$logs/pylon-test-cache-before.txt" "$logs/pylon-test-cache-after.txt" | wc -l)"
  docker images -q --no-trunc | sort -u > "$logs/pylon-test-images-after.txt"
  docker ps -a -q --no-trunc | sort -u > "$logs/pylon-test-containers-after.txt"
  echo "NEW_IMAGES=$(comm -13 "$logs/pylon-test-images-before.txt" "$logs/pylon-test-images-after.txt" | wc -l)"
  echo "NEW_CONTAINERS=$(comm -13 "$logs/pylon-test-containers-before.txt" "$logs/pylon-test-containers-after.txt" | wc -l)"
  echo "GONE_IMAGES=$(comm -23 "$logs/pylon-test-images-before.txt" "$logs/pylon-test-images-after.txt" | wc -l)"
  echo "GONE_CONTAINERS=$(comm -23 "$logs/pylon-test-containers-before.txt" "$logs/pylon-test-containers-after.txt" | wc -l)"
}
trap cleanup EXIT

if [ -z "$base_before" ]; then docker pull "$base"; fi
docker build --label "$label" --tag "$tag" "$here"

config="$TMPDIR/pylon-test-gondolin.json"
cat > "$config" <<EOF
{
  "arch": "x86_64",
  "distro": "alpine",
  "oci": {
    "image": "$tag",
    "runtime": "docker",
    "platform": "linux/amd64",
    "pullPolicy": "never"
  },
  "rootfs": { "sizeMb": 6144 },
  "init": { "rootfsInitExtra": "$repo/images/pylon/rootfs-init-extra.sh" },
  "postBuild": {
    "copy": [{ "src": "$seed", "dest": "/lib/modules" }]
  }
}
EOF

cd "$spikes"
TIMEFORMAT='BUILD_SECONDS=%3R'
time timeout 240 tools/node-v24.22.1-linux-x64/bin/node node_modules/@earendil-works/gondolin/dist/bin/gondolin.js build --config "$config" --output "$partial"
rm "$config"
node "$repo/images/pylon-test/restore-modes.ts" "$tag" "$partial" "$label"
mv "$partial" "$out"
cat "$out/manifest.json"
