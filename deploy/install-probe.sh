#!/usr/bin/env bash
# Installs or upgrades the Nexus probe on this node from the checkout this script is in. Run as root:
#   sudo deploy/install-probe.sh
#
# Safe to rerun. Each distinct source tree becomes /opt/nexus/releases/<content hash>, root-owned, and
# /opt/nexus/current points at the newest. A release is never changed or removed in place, because a pylon
# controller keeps running the release it started from after the probe moves on.
#
# It never overwrites /etc/nexus/probe.json or the values in /etc/nexus/secrets.env. The first run installs
# both from the examples and leaves the unit stopped until the config is edited. The probe restarts only when
# its release or unit file differs from what it was last started with (/opt/nexus/active-release). Restart it
# yourself after editing the config.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
prefix=/opt/nexus
state=/var/lib/nexus
etc=/etc/nexus
unit=/etc/systemd/system/nexus-probe.service
service_path=/usr/local/bin:/usr/bin

fail() { echo "install-probe: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "run as root: sudo $0"
[ -c /dev/kvm ] || fail "/dev/kvm is missing, so this node cannot run pylon VMs"
getent group kvm >/dev/null || fail "there is no kvm group to give the nexus user"
node_major=$(PATH=$service_path node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || node_major=none
[ "$node_major" != none ] && [ "$node_major" -ge 26 ] || fail "the unit needs Node 26 or newer in $service_path, found $node_major"

if ! id nexus >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$state" --no-create-home --shell "$(command -v nologin)" nexus
fi
usermod --append --groups kvm nexus
# Everything under $state belongs to the service user, who can swap any entry in it for a symlink. Root
# touches only $state itself, which sits in root-owned /var/lib, and its children are made as nexus.
for dir in "$state" "$state/pylons" "$state/artifacts"; do
  if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then fail "$dir is a symlink or not a directory. Refusing to touch it as root"; fi
done
[ -d "$state" ] || mkdir -m 0700 "$state"
chown -h nexus:nexus "$state"
chmod 0700 "$state"
runuser -u nexus -- mkdir -p -m 0700 "$state/pylons" "$state/artifacts"
runuser -u nexus -- chmod 0700 "$state/pylons" "$state/artifacts"
install -d -o root -g root -m 0755 "$prefix" "$prefix/releases" "$etc"

# A staging directory left by an interrupted run holds nothing a later run needs.
rm -rf "$prefix"/releases/.staging.*
staging=$(mktemp -d "$prefix/releases/.staging.XXXXXX")
trap 'rm -rf "$staging"' EXIT
tar -C "$repo" -cf - package.json package-lock.json tsconfig.json src | tar -C "$staging" --no-same-owner -xf -
release=$(cd "$staging" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12)
if [ -d "$prefix/releases/$release" ]; then
  echo "release $release is already installed"
else
  (cd "$staging" && PATH=$service_path npm ci --omit=dev --no-audit --no-fund)
  chown -R root:root "$staging"
  chmod -R u+rwX,go+rX,go-w "$staging"
  mv "$staging" "$prefix/releases/$release"
  echo "installed release $release"
fi

if [ "$(readlink "$prefix/current" || true)" != "releases/$release" ]; then
  ln -sfn "releases/$release" "$prefix/current.new"
  mv -T "$prefix/current.new" "$prefix/current"
fi

[ -e "$etc/probe.json" ] || install -o root -g root -m 0644 "$repo/deploy/probe.example.json" "$etc/probe.json"
[ -e "$etc/secrets.env" ] || install -m 0640 "$repo/deploy/secrets.example.env" "$etc/secrets.env"
chown root:nexus "$etc/secrets.env"
chmod 0640 "$etc/secrets.env"

if ! cmp -s "$repo/deploy/nexus-probe.service" "$unit"; then
  install -o root -g root -m 0644 "$repo/deploy/nexus-probe.service" "$unit"
  systemctl daemon-reload
fi
systemctl enable nexus-probe.service

if cmp -s "$repo/deploy/probe.example.json" "$etc/probe.json"; then
  echo "$etc/probe.json is still the example. Edit it (and $etc/secrets.env), then rerun $0"
  exit 0
fi
# What the running probe was last started with, written only once it runs. A run that died between the
# swap above and the restart below leaves it stale, so the next run still restarts.
active="$release $(sha256sum < "$unit" | cut -c1-12)"
if [ "$(cat "$prefix/active-release" 2>/dev/null || true)" != "$active" ]; then
  systemctl restart nexus-probe.service
else
  systemctl start nexus-probe.service
fi
sleep 3
if ! systemctl is-active --quiet nexus-probe.service; then
  journalctl -u nexus-probe.service -n 20 --no-pager
  fail "nexus-probe.service is not running"
fi
printf '%s\n' "$active" > "$prefix/active-release.new"
mv -T "$prefix/active-release.new" "$prefix/active-release"
echo "nexus-probe.service is running release $release"
