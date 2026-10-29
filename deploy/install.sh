#!/usr/bin/env bash
# Installs or upgrades Nexus on this machine from the checkout this script is in: the control plane, a probe and the
# deployer, or with --node only a probe and the deployer. Run as root:
#   sudo deploy/install.sh --admit <your Mac's tailnet name> --dotfiles <git URL>
#   sudo deploy/install.sh --node <the control plane's tailnet name>
#
# It checks every prerequisite first, and stops before changing anything when one is missing. It writes
# /etc/nexus/control.json, probe.json and deployer.json from `tailscale status --json` (src/deploy/setup.ts), runs
# the role installers, then asks for the agents' credentials this machine lacks (src/deploy/credentials.ts), and ends
# with what is left for the person. Without a terminal, or with --non-interactive, the credentials come from NEXUS_*
# variables instead. Safe to rerun: an existing config keeps its values and secrets, and gains only what is missing,
# and an existing credential is left as it is.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/release.sh
. "$repo/deploy/release.sh"

usage="usage: sudo deploy/install.sh [--node <control plane device>] [--admit <device>]... [--add-node <device>=<deploy key digest>]... [--peer <device>]... [--dotfiles <git URL>] [--non-interactive]"

# The machine's facts, one function each, so the tests can fake a machine.
uid() { id -u; }
kernel() { uname -s; }
systemd_booted() { [ -d /run/systemd/system ]; }
in_service_path() { PATH=$service_path command -v "$1" >/dev/null; }
kvm_device() { [ -c /dev/kvm ]; }
kvm_device_group() { stat -c %G /dev/kvm; }
machine() { uname -m; }
package_manager() {
  if command -v apt-get >/dev/null; then echo apt; elif command -v dnf >/dev/null; then echo dnf; else echo other; fi
}
tailscale_status() { PATH=$service_path tailscale status --json 2>/dev/null; }
# The running tailscaled's environment when root can read it, so a drop-in that awaits a restart does not count.
tailscaled_environment() {
  local pid
  pid=$(systemctl show tailscaled --property=MainPID --value 2>/dev/null) || pid=0
  if [ "${pid:-0}" != 0 ] && [ -r "/proc/$pid/environ" ]; then
    tr '\0' '\n' < "/proc/$pid/environ"
  else
    systemctl show tailscaled --property=Environment --value 2>/dev/null | tr ' ' '\n'
  fi
}
control_config_exists() { [ -e /etc/nexus/control.json ]; }

misses=()
# $1 says what is missing, and each further argument is one line of its fix.
miss() {
  local entry="- $1" line
  shift
  for line in "$@"; do entry+=$'\n'"    $line"; done
  misses+=("$entry")
}

# Records every prerequisite this machine misses for the role, control or node, and changes nothing. $3 is the command
# line to rerun.
check_prerequisites() {
  local role=$1 dotfiles=$2 rerun=$3 major qemu packages status
  [ "$(uid)" = 0 ] || miss "The installer changes the system, so it runs as root." "$rerun"
  if [ "$(kernel)" != Linux ] || ! systemd_booted; then
    miss "Nexus runs as systemd services, and this machine is not a Linux booted with systemd." "Install on a Linux that boots with systemd, such as Debian 12, Ubuntu 24.04 or Fedora 42."
  fi

  local manager
  manager=$(package_manager)
  major=$(node_major)
  if [ "$major" = none ] || [ "$major" -lt 26 ]; then
    case $manager in
      apt) miss "Node 26 or newer must be in $service_path, found $major." "curl -fsSL https://deb.nodesource.com/setup_26.x | sudo bash - && sudo apt-get install -y nodejs" ;;
      dnf) miss "Node 26 or newer must be in $service_path, found $major." "curl -fsSL https://rpm.nodesource.com/setup_26.x | sudo bash - && sudo dnf install -y nodejs" ;;
      *) miss "Node 26 or newer must be in $service_path, found $major." "Install Node 26 from https://nodejs.org/en/download into /usr/local." ;;
    esac
  fi

  qemu=qemu-system-$(machine)
  if ! in_service_path "$qemu" || ! in_service_path qemu-img; then
    case $manager:$(machine) in
      apt:aarch64) packages="sudo apt-get install -y qemu-system-arm qemu-utils" ;;
      apt:*) packages="sudo apt-get install -y qemu-system-x86 qemu-utils" ;;
      dnf:*) packages="sudo dnf install -y $qemu-core qemu-img" ;;
      *) packages="Install QEMU so that $qemu and qemu-img are in $service_path." ;;
    esac
    miss "Pylons are QEMU VMs, and $qemu or qemu-img is not in $service_path." "$packages"
  fi
  if ! kvm_device; then
    miss "/dev/kvm is missing, so QEMU cannot run pylons with KVM." "Turn on hardware virtualization (Intel VT-x or AMD-V) in the firmware, then:" "sudo modprobe kvm_intel || sudo modprobe kvm_amd"
  elif [ "$(kvm_device_group)" != kvm ]; then
    miss "/dev/kvm does not belong to the kvm group, which the probe's user joins to run QEMU." "sudo groupadd --system --force kvm && sudo udevadm trigger --name-match=kvm"
  fi

  if ! in_service_path tailscale; then
    miss "Tailscale is not installed in $service_path. Nexus reaches its nodes and callers over the tailnet." "curl -fsSL https://tailscale.com/install.sh | sh" "sudo tailscale up"
  elif ! status=$(tailscale_status) || ! grep -Eq '"BackendState": *"Running"' <<<"$status"; then
    miss "Tailscale is not running and logged in." "sudo systemctl enable --now tailscaled && sudo tailscale up"
  else
    grep -Eq '"MagicDNSEnabled": *true' <<<"$status" \
      || miss "MagicDNS is off. Nodes and preview URLs are named by MagicDNS." "Turn on MagicDNS at https://login.tailscale.com/admin/dns"
    grep -Eq '"CertDomains": *\[ *("|$)' <<<"$status" \
      || miss "HTTPS certificates are off. Previews and the dashboard are served over HTTPS." "Turn on HTTPS Certificates at https://login.tailscale.com/admin/dns"
  fi

  [ "$role" = control ] || return 0
  if ! tailscaled_environment | grep -qx 'TS_PERMIT_CERT_UID=nexus-control'; then
    miss "tailscaled does not let nexus-control fetch the dashboard's certificate. Restarting tailscaled drops tailnet connections for a moment." \
      "sudo mkdir -p /etc/systemd/system/tailscaled.service.d" \
      "printf '[Service]\\nEnvironment=TS_PERMIT_CERT_UID=nexus-control\\n' | sudo tee /etc/systemd/system/tailscaled.service.d/nexus-cert.conf >/dev/null" \
      "sudo systemctl daemon-reload && sudo systemctl restart tailscaled"
  fi
  if [ -z "$dotfiles" ] && ! control_config_exists; then
    miss "A first control plane install needs the dotfiles repository every pylon pulls on boot." "$rerun --dotfiles https://github.com/<you>/dotfiles.git"
  fi
}

main() {
  local role=control dotfiles="" roles next failed=0
  local args=("$@")
  while [ $# -gt 0 ]; do
    case $1 in
      --node) role=node; shift 2 || fail "--node needs the control plane's tailnet name. $usage" ;;
      --dotfiles) dotfiles=${2:-}; shift 2 || fail "--dotfiles needs a git URL. $usage" ;;
      --admit|--add-node|--peer) shift 2 || fail "$1 needs a value. $usage" ;;
      --non-interactive) shift ;;
      -h|--help) echo "$usage"; exit 0 ;;
      *) fail "unknown argument $1. $usage" ;;
    esac
  done

  check_prerequisites "$role" "$dotfiles" "sudo deploy/install.sh${args[*]:+ ${args[*]}}"
  if [ ${#misses[@]} -gt 0 ]; then
    echo "This machine is missing ${#misses[@]} prerequisite(s). Nothing was changed. Fix each, then rerun:" >&2
    printf '%s\n' "${misses[@]}" >&2
    exit 1
  fi

  # The deployer's lock, which every installer and the deployer's worker take, keeps two runs from merging at once.
  install -d -o root -g root -m 0700 "$prefix/deployer"
  PATH=$service_path flock -x "$prefix/deployer/lock" node "$repo/src/deploy/setup.ts" write "${args[@]}"
  if [ "$role" = control ]; then
    bash "$repo/deploy/install-control.sh"
    roles="control probe"
  else
    roles=probe
  fi
  bash "$repo/deploy/install-probe.sh"
  # shellcheck disable=SC2086
  bash "$repo/deploy/install-deployer.sh" $roles

  echo
  # It runs runuser and chown, which live in the sbin directories the units' PATH lacks.
  next=$(PATH=$service_path:$PATH node "$repo/src/deploy/setup.ts" credentials "${args[@]}") || failed=$?
  if grep -qx watch <<<"$next"; then
    PATH=$service_path flock -x "$prefix/deployer/lock" node "$repo/src/deploy/setup.ts" write "${args[@]}" --github-watch
  elif grep -qx config <<<"$next"; then
    PATH=$service_path flock -x "$prefix/deployer/lock" node "$repo/src/deploy/setup.ts" write "${args[@]}"
  fi
  if grep -qx config <<<"$next"; then
    bash "$repo/deploy/install-probe.sh"
  elif grep -qx probe <<<"$next"; then
    systemctl try-restart nexus-probe.service
  fi
  if grep -qx control <<<"$next"; then bash "$repo/deploy/install-control.sh"; fi
  [ "$failed" = 0 ] || fail "the credentials step failed, after the restarts its writes needed. Fix what it said, then rerun"
  echo
  PATH=$service_path node "$repo/src/deploy/setup.ts" left "${args[@]}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
