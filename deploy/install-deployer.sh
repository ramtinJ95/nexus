#!/usr/bin/env bash
# Installs the root deployer for the roles this machine runs, control and probe. deploy/install.sh runs it after
# src/deploy/setup.ts writes /etc/nexus/deployer.json and puts its token's digest in the control plane's deployKeys.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
. "$repo/deploy/release.sh"
[ "$(id -u)" = 0 ] || fail "run as root"
[ $# -gt 0 ] || fail "name the roles: control, probe or both"
for role in "$@"; do [[ "$role" = control || "$role" = probe ]] || fail "unknown role $role"; done
[ -e /etc/nexus/deployer.json ] || fail "/etc/nexus/deployer.json is missing. Run sudo deploy/install.sh, which writes it"
# The supervisor holds this lock while a worker runs from the files below.
take_deployer_lock
install -d -o root -g root -m 0700 "$prefix/deployer/roles"
# Only a manual install refreshes the recovery implementation and supervisor.
bootstrap=$prefix/deployer/bootstrap
install -d -o root -g root -m 0700 "$bootstrap/src/deploy"
rm -f "$bootstrap"/src/deploy/*.test.ts
# The worker's runtime sources. A file the worker imports must be listed here.
cd "$repo"
for source in src/deploy/*.ts src/tailscale.ts src/json-file.ts; do
  [[ "$source" = *.test.ts ]] || install -o root -g root -m 0600 "$source" "$bootstrap/$source"
done
printf '{"type":"module"}\n' > "$bootstrap/package.json"
chown -R root:root "$bootstrap"
chmod -R go-rwx "$bootstrap"
install -o root -g root -m 0700 "$repo/deploy/supervise-deployer.sh" "$prefix/deployer/supervise.sh"
for role in "$@"; do touch "$prefix/deployer/roles/$role"; done
chown root:root /etc/nexus/deployer.json
chmod 0600 /etc/nexus/deployer.json
install_unit "$repo/deploy/nexus-deployer.service" nexus-deployer.service
install_unit "$repo/deploy/nexus-deployer.timer" nexus-deployer.timer
systemctl start nexus-deployer.timer
