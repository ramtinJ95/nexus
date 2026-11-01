#!/usr/bin/env bash
# Points this node at a control plane: writes /etc/nexus/control-plane.json, which the probe and the deployer read, and
# restarts the probe if it is running. The deployer reads the file on its next poll.
#
# Usage: sudo deploy/set-control-plane.sh <tailnet node ID> <url>, such as nAbCdEf1CNTRL http://100.64.0.2:7470/.
#
# Safe to rerun: the same control plane again changes nothing and restarts nothing. It does not move a control plane.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy/release.sh
. "$repo/deploy/release.sh"
[ "$(id -u)" = 0 ] || fail "run as root: sudo deploy/set-control-plane.sh <tailnet node ID> <url>"
[ $# = 2 ] || fail "usage: sudo deploy/set-control-plane.sh <tailnet node ID> <url>"
take_deployer_lock
PATH=$service_path node "$repo/src/deploy/control-plane.ts" set "$etc" "$1" "$2"
