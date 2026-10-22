#!/usr/bin/env bash
# Stream over s7-ssh.sh. All writes are scratch-local; no host installs here.
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache"
export PI_SANDBOX_HOME="$HOME/nexus-spikes/state"
export npm_config_cache="$HOME/nexus-spikes/npm-cache"
export TMPDIR="$HOME/nexus-spikes/tmp"
action=${1:?action required}
if [[ $action == init-firebat ]]; then
  test ! -e "$HOME/nexus-spikes"
  mkdir -p "$HOME/nexus-spikes"/{s7,cache,state,npm-cache,tmp}
  echo FIREBAT_SCRATCH_CREATED
  exit
fi
cd "$HOME/nexus-spikes"
case "$action" in
  init-testbench)
    test ! -e s7
    mkdir s7
    cp -a --reflink=auto --sparse=always state/debian-assets s7/assets
    sha256sum state/debian-assets/* > s7/original-assets.sha256
    find tmp -mindepth 1 -maxdepth 1 -printf '%f\n' | sort > s7/tmp-before.txt
    echo TESTBENCH_ASSETS_STAGED
    ;;
  npm)
    test ! -e node_modules
    sha256sum package.json package-lock.json
    npm ci --ignore-scripts --no-audit --no-fund
    node -p '"GONDOLIN_VERSION=" + require("@earendil-works/gondolin/package.json").version'
    sha256sum package.json package-lock.json
    ;;
  create|forward|return|relocated)
    timeout --signal=TERM --kill-after=15s 180s node s7/s7-vm.mjs "$action"
    ;;
  pack-forward)
    cd s7
    sha256sum assets/* intel.qcow2 tokens.json > forward.sha256
    cat forward.sha256
    qemu-img info --backing-chain intel.qcow2
    stat --printf='CHECKPOINT_LOGICAL_BYTES=%s\n' intel.qcow2
    du -B1 intel.qcow2
    tar -Sczf forward.tar.gz assets intel.qcow2 tokens.json forward.sha256
    stat --printf='TRANSFER_ARCHIVE_BYTES=%s\n' forward.tar.gz
    sha256sum forward.tar.gz
    ;;
  verify-forward)
    cd s7
    sha256sum -c forward.sha256
    sha256sum assets/* intel.qcow2 tokens.json
    qemu-img info --backing-chain intel.qcow2
    ;;
  pack-return)
    cd s7
    sha256sum amd.qcow2 tokens.json > return.sha256
    cat return.sha256
    qemu-img info --backing-chain amd.qcow2
    stat --printf='CHECKPOINT_LOGICAL_BYTES=%s\n' amd.qcow2
    du -B1 amd.qcow2
    tar -Sczf return.tar.gz amd.qcow2 tokens.json return.sha256
    stat --printf='TRANSFER_ARCHIVE_BYTES=%s\n' return.tar.gz
    sha256sum return.tar.gz
    ;;
  verify-return)
    cd s7
    sha256sum -c return.sha256
    sha256sum amd.qcow2 tokens.json
    qemu-img info --backing-chain amd.qcow2
    ;;
  relocate)
    cd s7
    mv assets relocated-assets
    # The old backing path is absent. Content is identical (rename + SHA check).
    test ! -e assets
    sed 's|assets/|relocated-assets/|' forward.sha256 | grep 'relocated-assets/' | sha256sum -c -
    qemu-img rebase -u -f qcow2 -F raw -b "$PWD/relocated-assets/rootfs.ext4" amd.qcow2
    qemu-img info --backing-chain amd.qcow2
    ;;
  audit)
    node --version; qemu-system-x86_64 --version; qemu-img --version
    printf 'HOST_CPU='; awk -F ': ' '/^model name/ {print $2; exit}' /proc/cpuinfo
    uname -sr
    printf 'TMP_ENTRIES='; find tmp -mindepth 1 -maxdepth 1 | wc -l
    printf 'S7_QEMU_COUNT='; (pgrep -af qemu-system | grep '[n]exus-spikes/s7/' || true) | wc -l
    if test -f s7/original-assets.sha256; then
      sha256sum -c s7/original-assets.sha256
      diff -u s7/tmp-before.txt <(find tmp -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
    fi
    ;;
  *) echo "Unknown action: $action" >&2; exit 2;;
esac
