# shellcheck shell=bash
# Shared by deploy/install-probe.sh and deploy/install-control.sh, which source it as root.
#
# Each distinct source tree becomes /opt/nexus/releases/<content hash>, root-owned. A release is never changed
# or removed in place, because a pylon controller keeps running the release it started from after the probe
# moves on. Each service has its own link to the release it runs, so installing one never moves the other.

prefix=/opt/nexus
service_path=/usr/local/bin:/usr/bin

fail() { echo "$(basename "$0" .sh): $*" >&2; exit 1; }

require_node() {
  local major
  major=$(PATH=$service_path node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || major=none
  [ "$major" != none ] && [ "$major" -ge 26 ] || fail "the unit needs Node 26 or newer in $service_path, found $major"
}

# Installs the checkout at $1 as a release, unless an identical one exists, and sets $release to its hash.
install_release() {
  local repo=$1
  install -d -o root -g root -m 0755 "$prefix" "$prefix/releases"
  # A staging directory left by an interrupted run holds nothing a later run needs.
  rm -rf "$prefix"/releases/.staging.*
  staging=$(mktemp -d "$prefix/releases/.staging.XXXXXX")
  trap 'rm -rf "$staging"' EXIT
  # src/release.test.ts fails when src imports a file outside this list.
  tar -C "$repo" -cf - package.json package-lock.json tsconfig.json src deploy images/pylon/agent-setup/manifest.ts images/pylon/nexus-turn.ts | tar -C "$staging" --no-same-owner -xf -
  release=$(cd "$staging" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12)
  if [ -n "${NEXUS_COMMIT:-}" ]; then
    [[ "$NEXUS_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "NEXUS_COMMIT must be a full commit"
    release=$NEXUS_COMMIT
  fi
  if [ -d "$prefix/releases/$release" ]; then
    echo "release $release is already installed"
  else
    # The dashboard's client is bundled from its sources and their dev dependencies, which go once it is built.
    # Callers run this without errexit, so each step's failure stops here, and the EXIT trap removes the staging
    # directory, which leaves no release directory for a retry to take as installed.
    (cd "$staging" && PATH=$service_path npm ci --no-audit --no-fund) || fail "npm ci failed for release $release"
    (cd "$staging" && PATH=$service_path npm run build) || fail "the dashboard build failed for release $release"
    (cd "$staging" && PATH=$service_path npm prune --omit=dev --no-audit --no-fund) || fail "npm prune failed for release $release"
    printf '%s\n' "${NEXUS_COMMIT:-$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)}" > "$staging/release-commit" || fail "could not record the release's commit"
    chown -R root:root "$staging" && chmod -R u+rwX,go+rX,go-w "$staging" || fail "could not make release $release root-owned"
    mv "$staging" "$prefix/releases/$release" || fail "could not publish release $release"
    echo "installed release $release"
  fi
}

# Points the link $1 (such as /opt/nexus/current) at $release, atomically.
link_release() {
  local link=$1
  if [ "$(readlink "$link" || true)" != "releases/$release" ]; then
    ln -sfn "releases/$release" "$link.new"
    mv -T "$link.new" "$link"
  fi
}

# Installs the unit file $1 as /etc/systemd/system/$2 and enables it.
install_unit() {
  local source=$1 unit=/etc/systemd/system/$2
  if ! cmp -s "$source" "$unit"; then
    install -o root -g root -m 0644 "$source" "$unit"
    systemctl daemon-reload
  fi
  systemctl enable "$2"
}

# Starts the unit $1, restarting it when $release or its unit file differs from what the file $2 says it was
# last started with. The file is written only once the unit runs, so a run that died between the link swap
# and the restart leaves it stale, and the next run still restarts.
start_unit() {
  local unit=$1 active_file=$2 active
  active="$release $(sha256sum < "/etc/systemd/system/$unit" | cut -c1-12)"
  if [ "$(cat "$active_file" 2>/dev/null || true)" != "$active" ]; then
    systemctl restart "$unit"
  else
    systemctl start "$unit"
  fi
  sleep 3
  if ! systemctl is-active --quiet "$unit"; then
    journalctl -u "$unit" -n 20 --no-pager
    fail "$unit is not running"
  fi
  printf '%s\n' "$active" > "$active_file.new"
  mv -T "$active_file.new" "$active_file"
  echo "$unit is running release $release"
}

# Makes the system user $1 with home $2, the service's state directory. Everything under it belongs to the
# user, who can swap any entry in it for a symlink, so root touches only the directory itself, which sits in
# root-owned /var/lib. Any subdirectories, $3 onwards, are made as the user.
make_state() {
  local user=$1 state=$2 dir
  shift 2
  if ! id "$user" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$state" --no-create-home --shell "$(command -v nologin)" "$user"
  fi
  for dir in "$state" "${@/#/$state/}"; do
    if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then fail "$dir is a symlink or not a directory. Refusing to touch it as root"; fi
  done
  [ -d "$state" ] || mkdir -m 0700 "$state"
  chown -h "$user:$user" "$state"
  chmod 0700 "$state"
  if [ $# -gt 0 ]; then
    runuser -u "$user" -- mkdir -p -m 0700 "${@/#/$state/}"
    runuser -u "$user" -- chmod 0700 "${@/#/$state/}"
  fi
}
