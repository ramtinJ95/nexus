#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache" TMPDIR="$HOME/nexus-spikes/tmp"
cd "$HOME/nexus-spikes"
ulimit -c 0
if [ ! -L state/kernel-module-seed/6.18.58-0-virt/vmlinuz ]; then
  source_dir=
  for candidate in tmp/gondolin-build-*/initramfs-root/lib/modules/6.18.58-0-virt; do
    if [ -L "$candidate/vmlinuz" ]; then source_dir="$candidate"; break; fi
  done
  test -n "$source_dir" || { echo 'Missing matching Alpine module input; run the baseline build to extract it first.'; exit 1; }
  test "$(readlink "$source_dir/vmlinuz")" = /boot/vmlinuz-virt
  mkdir -p state/kernel-module-seed
  # Preserve unmodified upstream files and link text for documented postBuild.copy.
  cp -a "$source_dir" state/kernel-module-seed/
fi
test "$(readlink state/kernel-module-seed/6.18.58-0-virt/vmlinuz)" = /boot/vmlinuz-virt
echo 'MODULE_SEED=6.18.58-0-virt; unchanged Alpine files, absolute link preserved'
started=$(date +%s)
TIMEFORMAT='BUILD_SECONDS=%3R'
set +e
time timeout 240 tools/node-v24.22.1-linux-x64/bin/node node_modules/@earendil-works/gondolin/dist/bin/gondolin.js build --config s1-module-seed.json --output state/debian-assets
rc=$?
set -e
docker events --since "$started" --until "$(date +%s)" --filter type=container --filter image=debian:bookworm-slim \
  --format '{{.Action}} {{.Actor.ID}}' > logs/s12-docker-events-seed.txt
awk '$1 == "create" { print $2 }' logs/s12-docker-events-seed.txt >> state/s12-created-containers.txt
sort -u state/s12-created-containers.txt -o state/s12-created-containers.txt
exit "$rc"
