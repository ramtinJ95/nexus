#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
. "$repo/deploy/release.sh"
[ "$(id -u)" = 0 ] || fail "run as root"
role=${1:?control or probe}
[[ "$role" = control || "$role" = probe ]] || fail "unknown role"
install -d -o root -g root -m 0700 "$prefix/deployer" "$prefix/deployer/roles"
# Only a manual install refreshes the recovery implementation and supervisor.
install -d -o root -g root -m 0700 "$prefix/deployer/bootstrap/src/deploy"
cp "$repo/src/deploy/"*.ts "$prefix/deployer/bootstrap/src/deploy/"
install -o root -g root -m 0600 "$repo/src/tailscale.ts" "$prefix/deployer/bootstrap/src/tailscale.ts"
printf '{"type":"module"}\n' > "$prefix/deployer/bootstrap/package.json"
chown -R root:root "$prefix/deployer/bootstrap"
chmod -R go-rwx "$prefix/deployer/bootstrap"
install -o root -g root -m 0700 "$repo/deploy/supervise-deployer.sh" "$prefix/deployer/supervise.sh"
touch "$prefix/deployer/roles/$role"
if [ ! -e /etc/nexus/deployer.json ]; then
  node --input-type=module - "$role" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const role = process.argv[2];
const local = JSON.parse(readFileSync(`/etc/nexus/${role}.json`, 'utf8'));
const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }));
const controlNodeId = role === 'control' ? local.self.tailnetNodeId : local.auth.controlPlane;
const control = [status.Self, ...Object.values(status.Peer ?? {})].find(n => n.ID === controlNodeId || n.StableID === controlNodeId);
if (!control) throw new Error(`tailscale has no control node ${controlNodeId}; create /etc/nexus/deployer.json manually`);
const host = role === 'control' ? local.listen.host : control.DNSName.replace(/\.$/, '');
const controlUrl = `http://${host.includes(':') ? `[${host}]` : host}:${role === 'control' ? local.listen.port : 7470}/`;
const token = randomBytes(32).toString('hex');
writeFileSync('/etc/nexus/deployer.json', JSON.stringify({ controlUrl, controlNodeId, token, drainTimeoutMs: 300000, healthTimeoutMs: 60000 }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(`Add deployKeys[${JSON.stringify(status.Self.ID ?? status.Self.StableID)}] = ${JSON.stringify(createHash('sha256').update(token).digest('hex'))} to control.json, then restart control once.`);
JS
fi
chown root:root /etc/nexus/deployer.json
chmod 0600 /etc/nexus/deployer.json
install_unit "$repo/deploy/nexus-deployer.service" nexus-deployer.service
install_unit "$repo/deploy/nexus-deployer.timer" nexus-deployer.timer
systemctl start nexus-deployer.timer
