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
install -d -o root -g root -m 0700 "$prefix/deployer" "$prefix/deployer/roles"
# The supervisor holds this lock while a worker runs from the files below.
exec 9>"$prefix/deployer/lock"
flock -x 9
# Only a manual install refreshes the recovery implementation and supervisor.
install -d -o root -g root -m 0700 "$prefix/deployer/bootstrap/src/deploy"
cp "$repo/src/deploy/"*.ts "$prefix/deployer/bootstrap/src/deploy/"
install -o root -g root -m 0600 "$repo/src/tailscale.ts" "$prefix/deployer/bootstrap/src/tailscale.ts"
install -o root -g root -m 0600 "$repo/src/json-file.ts" "$prefix/deployer/bootstrap/src/json-file.ts"
printf '{"type":"module"}\n' > "$prefix/deployer/bootstrap/package.json"
chown -R root:root "$prefix/deployer/bootstrap"
chmod -R go-rwx "$prefix/deployer/bootstrap"
install -o root -g root -m 0700 "$repo/deploy/supervise-deployer.sh" "$prefix/deployer/supervise.sh"
for role in "$@"; do touch "$prefix/deployer/roles/$role"; done
chown root:root /etc/nexus/deployer.json
chmod 0600 /etc/nexus/deployer.json
install_unit "$repo/deploy/nexus-deployer.service" nexus-deployer.service
install_unit "$repo/deploy/nexus-deployer.timer" nexus-deployer.timer
systemctl start nexus-deployer.timer
