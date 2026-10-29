#!/usr/bin/env bash
# Installs or upgrades the Nexus probe on this node from the checkout this script is in. deploy/install.sh runs it
# after writing /etc/nexus/probe.json, and the deployer runs it with NEXUS_PREPARE=1 from each release it installs,
# by this name.
#
# Safe to rerun. The release becomes /opt/nexus/releases/<content hash> (see deploy/release.sh), and
# /opt/nexus/current points at the newest.
#
# It installs /etc/nexus/secrets.env from the example on the first run, and never overwrites it or changes its owner
# or mode after. The probe restarts only when its release, unit file or config differs from what it was last started
# with (/opt/nexus/active-release). Restart it yourself after editing secrets.env.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/release.sh
. "$repo/deploy/release.sh"
[ "$(id -u)" = 0 ] || fail "run as root: sudo deploy/install.sh"

if [ "${NEXUS_PREPARE:-0}" = 1 ]; then prepare_probe "$repo"; exit 0; fi
take_deployer_lock
prepare_probe "$repo"
link_release "$prefix/current"
start_unit nexus-probe.service "$prefix/active-release" "$etc/probe.json"
