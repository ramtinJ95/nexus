# shellcheck shell=bash
# Shared by deploy/install.sh and the role installers it runs, deploy/install-control.sh and deploy/install-probe.sh,
# which source it as root.
#
# Each distinct source tree becomes /opt/nexus/releases/<content hash>, root-owned. A release is never changed
# or removed in place, because a pylon controller keeps running the release it started from after the probe
# moves on. Each service has its own link to the release it runs, so installing one never moves the other.

prefix=/opt/nexus
etc=/etc/nexus
service_path=/usr/local/bin:/usr/bin

fail() { echo "$(basename "$0" .sh): $*" >&2; exit 1; }

# The major version of the Node the units run, or none.
node_major() {
  PATH=$service_path node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none
}

# Installs the checkout at $1 as a release, unless an identical one exists, and sets $release to its hash.
install_release() {
  local repo=$1
  # Callers run this without errexit, so every step up to the publish checks its own failure, and pipefail, kept
  # to this function, makes a pipeline fail when any part of it does. A failure exits, and the EXIT trap removes
  # the staging directory, which leaves no release directory for a retry to take as installed.
  local -
  set -o pipefail
  install -d -o root -g root -m 0755 "$prefix" "$prefix/releases" || fail "could not make $prefix/releases"
  # A staging directory left by an interrupted run holds nothing a later run needs.
  rm -rf "$prefix"/releases/.staging.* || fail "could not remove old staging directories"
  staging=$(mktemp -d "$prefix/releases/.staging.XXXXXX") || fail "could not make a staging directory"
  trap 'rm -rf "$staging"' EXIT
  # src/release.test.ts fails when src imports a file outside this list. loadImageRecipe sends every file under images/pylon, so it goes whole.
  tar -C "$repo" -cf - package.json package-lock.json tsconfig.json src deploy images/pylon | tar -C "$staging" --no-same-owner -xf - \
    || fail "could not copy $repo into the release"
  release=$(cd "$staging" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12) || fail "could not hash the release"
  if [ -n "${NEXUS_COMMIT:-}" ]; then
    [[ "$NEXUS_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "NEXUS_COMMIT must be a full commit"
    release=$NEXUS_COMMIT
  fi
  if [ -d "$prefix/releases/$release" ]; then
    echo "release $release is already installed"
  else
    # The dashboard's client is bundled from its sources and their dev dependencies, which go once it is built.
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

# Holds the deployer's lock on fd 9 until the script exits. The deployer's supervisor and every installer take it, so
# no two of them change releases at once.
take_deployer_lock() {
  install -d -o root -g root -m 0700 "$prefix/deployer"
  exec 9>"$prefix/deployer/lock"
  flock -x 9
}

# Runs the command $@ under the deployer's lock, which it holds only until the command exits. A script that runs the
# role installers takes the lock this way, because each installer takes it itself.
with_deployer_lock() {
  install -d -o root -g root -m 0700 "$prefix/deployer"
  flock -x "$prefix/deployer/lock" "$@"
}

# Writes $etc/control-plane.json from probe.json and deployer.json on the first release that reads it, and checks it after.
adopt_control_plane() { PATH=$service_path node "$1/src/deploy/control-plane.ts" adopt "$etc"; }

# The control plane's upgrade steps from the checkout at $1, which neither switch its link nor start it. The deployer
# runs them alone, as `NEXUS_PREPARE=1 install-control.sh`.
prepare_control() {
  make_state nexus-control /var/lib/nexus-control
  install -d -o root -g root -m 0755 "$etc"
  adopt_control_plane "$1"
  install_release "$1"
  install_unit "$1/deploy/nexus-control.service" nexus-control.service
  install_unit "$1/deploy/nexus-backup.service" nexus-backup.service
  install_unit "$1/deploy/nexus-backup.timer" nexus-backup.timer
}

# The probe's upgrade steps from the checkout at $1, which neither switch its link nor start it. The deployer runs them
# alone, as `NEXUS_PREPARE=1 install-probe.sh`.
prepare_probe() {
  make_state nexus /var/lib/nexus pylons artifacts
  usermod --append --groups kvm nexus
  # Previews are `tailscale serve` entries, which only root and the operator may change. tailscaled has one
  # operator, so this replaces any other user's operator rights.
  tailscale set --operator=nexus
  install -d -o root -g root -m 0755 "$etc"
  adopt_control_plane "$1"
  install_release "$1"
  [ -e "$etc/secrets.env" ] || install -o root -g nexus -m 0640 "$1/deploy/secrets.example.env" "$etc/secrets.env"
  install_unit "$1/deploy/nexus-probe.service" nexus-probe.service
  # `nexus attach` goes through the control plane now. A sudo grant for the old node-side helper would outlive it.
  rm -f /usr/local/bin/nexus-attach /etc/sudoers.d/nexus-attach
  if getent group nexus-attach >/dev/null; then groupdel nexus-attach; fi
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

# Starts the unit $1, restarting it when $release, its unit file or one of its config files, $3 onwards, differs from
# what the file $2 says it was last started with. The file is written only once the unit runs, so a run that died between the link
# swap and the restart leaves it stale, and the next run still restarts.
start_unit() {
  local unit=$1 active_file=$2 config active
  shift 2
  active="$release $(sha256sum < "/etc/systemd/system/$unit" | cut -c1-12)"
  for config in "$@"; do active+=" $(sha256sum < "$config" | cut -c1-12)"; done
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
