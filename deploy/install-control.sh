#!/usr/bin/env bash
# Installs or upgrades the Nexus control plane on this machine from the checkout this script is in. It runs
# on rj-firebat, beside that node's probe. Run as root:
#   sudo deploy/install-control.sh
#
# Safe to rerun. The release becomes /opt/nexus/releases/<content hash> (see deploy/release.sh), and
# /opt/nexus/control-current points at the newest, apart from the probe's /opt/nexus/current.
#
# It never overwrites /etc/nexus/control.json. The first run installs it from the example and leaves the unit
# stopped until the config is edited. The control plane restarts only when its release or unit file differs
# from what it was last started with (/opt/nexus/control-active-release). Restart it yourself after editing
# the config.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/release.sh
. "$repo/deploy/release.sh"
state=/var/lib/nexus-control
etc=/etc/nexus

[ "$(id -u)" = 0 ] || fail "run as root: sudo $0"
require_node

make_state nexus-control "$state"
install -d -o root -g root -m 0755 "$etc"

if [ "${NEXUS_PREPARE:-0}" != 1 ]; then
  install -d -o root -g root -m 0700 "$prefix/deployer"
  exec 9>"$prefix/deployer/lock"
  flock -x 9
fi
install_release "$repo"
[ "${NEXUS_PREPARE:-0}" = 1 ] || link_release "$prefix/control-current"

[ -e "$etc/control.json" ] || install -o root -g root -m 0644 "$repo/deploy/control.example.json" "$etc/control.json"
install_unit "$repo/deploy/nexus-control.service" nexus-control.service

[ "${NEXUS_PREPARE:-0}" != 1 ] || exit 0

if cmp -s "$repo/deploy/control.example.json" "$etc/control.json"; then
  echo "$etc/control.json is still the example. Edit it, sign the harness in with"
  echo "  sudo -u nexus-control env PATH=$service_path node $prefix/control-current/src/control/login.ts $etc/control.json"
  echo "then rerun $0"
  exit 0
fi
start_unit nexus-control.service "$prefix/control-active-release"

bash "$repo/deploy/install-deployer.sh" control
