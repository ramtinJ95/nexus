#!/usr/bin/env bash
# Installs or upgrades the Nexus probe on this node from the checkout this script is in. deploy/install.sh runs it
# after writing /etc/nexus/probe.json, and the deployer runs it with NEXUS_PREPARE=1 from each release it installs,
# by this name.
#
# Safe to rerun. The release becomes /opt/nexus/releases/<content hash> (see deploy/release.sh), and
# /opt/nexus/current points at the newest.
#
# It never overwrites the values in /etc/nexus/secrets.env, which the first run installs from the example. The probe
# restarts only when its release, unit file or config differs from what it was last started with
# (/opt/nexus/active-release). Restart it yourself after editing secrets.env.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/release.sh
. "$repo/deploy/release.sh"
state=/var/lib/nexus
etc=/etc/nexus

[ "$(id -u)" = 0 ] || fail "run as root: sudo deploy/install.sh"

make_state nexus "$state" pylons artifacts
usermod --append --groups kvm nexus
# Previews are `tailscale serve` entries, which only root and the operator may change. tailscaled has one
# operator, so this replaces any other user's operator rights.
tailscale set --operator=nexus
install -d -o root -g root -m 0755 "$etc"

if [ "${NEXUS_PREPARE:-0}" != 1 ]; then
  install -d -o root -g root -m 0700 "$prefix/deployer"
  exec 9>"$prefix/deployer/lock"
  flock -x 9
fi
install_release "$repo"
[ "${NEXUS_PREPARE:-0}" = 1 ] || link_release "$prefix/current"

[ -e "$etc/secrets.env" ] || install -m 0640 "$repo/deploy/secrets.example.env" "$etc/secrets.env"
chown root:nexus "$etc/secrets.env"
chmod 0640 "$etc/secrets.env"

install_unit "$repo/deploy/nexus-probe.service" nexus-probe.service

# `nexus attach` goes through the control plane now. A sudo grant for the old node-side helper would outlive it.
rm -f /usr/local/bin/nexus-attach /etc/sudoers.d/nexus-attach
if getent group nexus-attach >/dev/null; then groupdel nexus-attach; fi

[ "${NEXUS_PREPARE:-0}" != 1 ] || exit 0

start_unit nexus-probe.service "$prefix/active-release" "$etc/probe.json"
