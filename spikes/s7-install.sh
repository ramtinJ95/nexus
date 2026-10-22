#!/usr/bin/env bash
# Firebat only. This is the complete authorized host mutation.
set -euo pipefail
versions() {
  pacman -Q qemu-base nodejs npm || true
  for bin in node qemu-system-x86_64 qemu-img; do
    if command -v "$bin" >/dev/null; then "$bin" --version; else echo "$bin ABSENT"; fi
  done
}
echo BEFORE
versions
before=$(pacman -Q | sort)
set +e
sudo -n pacman -S --needed --noconfirm qemu-base nodejs npm
rc=$?
set -e
echo "INSTALL_EXIT=$rc"
echo AFTER
versions
echo TRANSACTION_ADDED_OR_CHANGED
comm -13 <(printf '%s\n' "$before") <(pacman -Q | sort)
exit "$rc"
