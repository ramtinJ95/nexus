#!/usr/bin/env bash
# Run on the named host only after saving S7 evidence to the Mac.
set -euo pipefail
role=${1:?testbench or firebat}
case "$role" in testbench|firebat) ;; *) exit 2;; esac
cd "$HOME/nexus-spikes"
test -f s7/s7-vm.mjs
qemu=$( (pgrep -au "$(id -u)" -f 'qemu-system' | grep '[n]exus-spikes/' || true) | wc -l)
echo "SCRATCH_QEMU=$qemu"
test "$qemu" -eq 0
sessions=$(find cache/gondolin/sessions -mindepth 1 -maxdepth 1 | wc -l)
echo "SESSIONS=$sessions"
test "$sessions" -eq 0
if [[ $role == testbench ]]; then
  diff -u s7/tmp-before.txt <(find tmp -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
  test "$(grep -c ': OK$' s7/original-assets-check.txt)" -eq 6
  echo ORIGINAL_BASE_HASHES_VERIFIED=6
  rm -rf -- "$HOME/nexus-spikes/s7"
  test ! -e s7
  echo S7_ABSENT=yes
  echo ORIGINAL_NEXUS_SPIKES_RETAINED=yes
  printf 'TMP_ENTRIES='; find tmp -mindepth 1 -maxdepth 1 | wc -l
else
  # Recon established this whole directory was absent before S7.
  cd "$HOME"
  rm -rf -- "$HOME/nexus-spikes"
  test ! -e "$HOME/nexus-spikes"
  echo NEXUS_SPIKES_ABSENT=yes
  pacman -Q qemu-base nodejs npm
fi
