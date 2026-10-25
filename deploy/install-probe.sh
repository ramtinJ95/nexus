#!/usr/bin/env bash
# Installs or upgrades the Nexus probe on this node from the checkout this script is in. Run as root:
#   sudo deploy/install-probe.sh
#
# Safe to rerun. The release becomes /opt/nexus/releases/<content hash> (see deploy/release.sh), and
# /opt/nexus/current points at the newest.
#
# It never overwrites /etc/nexus/probe.json or the values in /etc/nexus/secrets.env. The first run installs
# both from the examples and leaves the unit stopped until the config is edited. The probe restarts only when
# its release or unit file differs from what it was last started with (/opt/nexus/active-release). Restart it
# yourself after editing the config.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/release.sh
. "$repo/deploy/release.sh"
state=/var/lib/nexus
etc=/etc/nexus

[ "$(id -u)" = 0 ] || fail "run as root: sudo $0"
[ -c /dev/kvm ] || fail "/dev/kvm is missing, so this node cannot run pylon VMs"
getent group kvm >/dev/null || fail "there is no kvm group to give the nexus user"
require_node
command -v tailscale >/dev/null || fail "there is no tailscale CLI, which the probe publishes previews with"

make_state nexus "$state" pylons artifacts
usermod --append --groups kvm nexus
# Previews are `tailscale serve` entries, which only root and the operator may change. tailscaled has one
# operator, so this replaces any other user's operator rights.
tailscale set --operator=nexus
install -d -o root -g root -m 0755 "$etc"

install_release "$repo"
[ "${NEXUS_PREPARE:-0}" = 1 ] || link_release "$prefix/current"

[ -e "$etc/probe.json" ] || install -o root -g root -m 0644 "$repo/deploy/probe.example.json" "$etc/probe.json"
[ -e "$etc/secrets.env" ] || install -m 0640 "$repo/deploy/secrets.example.env" "$etc/secrets.env"
chown root:nexus "$etc/secrets.env"
chmod 0640 "$etc/secrets.env"

install_unit "$repo/deploy/nexus-probe.service" nexus-probe.service

# `nexus attach` goes through the control plane now. A sudo grant for the old node-side helper would outlive it.
rm -f /usr/local/bin/nexus-attach /etc/sudoers.d/nexus-attach
if getent group nexus-attach >/dev/null; then groupdel nexus-attach; fi

[ "${NEXUS_PREPARE:-0}" != 1 ] || exit 0

if cmp -s "$repo/deploy/probe.example.json" "$etc/probe.json"; then
  echo "$etc/probe.json is still the example. Edit it (and $etc/secrets.env), then rerun $0"
  exit 0
fi
start_unit nexus-probe.service "$prefix/active-release"

bash "$repo/deploy/install-deployer.sh" probe
