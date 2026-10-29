#!/usr/bin/env bash
# Installs or upgrades the Nexus control plane on this machine from the checkout this script is in. deploy/install.sh
# runs it after writing /etc/nexus/control.json, and the deployer runs it with NEXUS_PREPARE=1 from each release it
# installs, by this name.
#
# Safe to rerun. The release becomes /opt/nexus/releases/<content hash> (see deploy/release.sh), and
# /opt/nexus/control-current points at the newest, apart from the probe's /opt/nexus/current.
#
# The control plane restarts only when its release, unit file or config differs from what it was last started with
# (/opt/nexus/control-active-release). It refuses to start before its harness is signed in, so until then the unit
# is installed and enabled but left stopped.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/release.sh
. "$repo/deploy/release.sh"
[ "$(id -u)" = 0 ] || fail "run as root: sudo deploy/install.sh"

if [ "${NEXUS_PREPARE:-0}" = 1 ]; then prepare_control "$repo"; exit 0; fi
take_deployer_lock
prepare_control "$repo"
link_release "$prefix/control-current"

signed_in() {
  PATH=$service_path node -e '
    const { readFileSync } = require("node:fs");
    const { harness } = JSON.parse(readFileSync(process.argv[1], "utf8"));
    process.exit(Object.keys(JSON.parse(readFileSync(harness.credentials, "utf8")).credentials ?? {}).length > 0 ? 0 : 1);
  ' "$etc/control.json" 2>/dev/null
}
if signed_in; then
  start_unit nexus-control.service "$prefix/control-active-release" "$etc/control.json"
else
  echo "nexus-control.service is installed and waits for the harness's ChatGPT login"
fi
