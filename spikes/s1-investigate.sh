#!/usr/bin/env bash
set -uo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache" TMPDIR="$HOME/nexus-spikes/tmp"
cd "$HOME/nexus-spikes"
printf '%s\n' '--- Host path metadata only ---'
ls -ld /boot
ls -l /boot/vmlinuz-virt
echo "HOST_KERNEL_LOOKUP_EXIT=$? (permission denial cannot establish existence)"
printf '%s\n' '--- Extracted roots and Alpine module links ---'
for build in tmp/gondolin-build-*; do
  [ -d "$build/rootfs" ] || continue
  echo "$build"
  ls -ld "$build/rootfs/boot" "$build/rootfs/lib" "$build/rootfs/usr/lib"
  ls -la "$build/rootfs/boot"
  find "$build/rootfs" -maxdepth 1 -name 'vmlinuz*' -exec ls -ld {} \;
  find "$build/initramfs-root/lib/modules" -maxdepth 2 -name vmlinuz -printf '%p -> %l\n'
done
printf '%s\n' '--- Gondolin module-copy implementation ---'
nl -ba node_modules/@earendil-works/gondolin/dist/src/alpine/kernel-modules.js | head -55
printf '%s\n' '--- Rootfs path containment ---'
nl -ba node_modules/@earendil-works/gondolin/dist/src/alpine/rootfs.js | head -160
printf '%s\n' '--- Build-stage order ---'
grep -R -nE 'syncKernelModules|applyPostBuildCopies' node_modules/@earendil-works/gondolin/dist/src --include='*.js'
printf '%s\n' '--- strace availability ---'
command -v strace || echo 'strace not installed; not added'
