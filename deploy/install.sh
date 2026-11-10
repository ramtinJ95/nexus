#!/usr/bin/env bash
# Installs or upgrades Nexus on this machine from the checkout this script is in: the control plane, a probe and the
# deployer, or with --node only a probe and the deployer. Run as root:
#   sudo deploy/install.sh --admit <your Mac's tailnet name> [--dotfiles <git URL>]
#   sudo deploy/install.sh --join-token                                  on the control plane's machine, which prints:
#   sudo deploy/install.sh --join <token> --node <the control plane's tailnet name>     on the new node
#   sudo deploy/install.sh --rotate claude|github                         replaces this machine's stored token
#
# It checks every prerequisite first, and stops before changing anything when one is missing. Then `src/deploy/setup.ts
# install` writes /etc/nexus/control.json, control-plane.json, probe.json and deployer.json from `tailscale status --json`,
# runs the role installers, asks for the agents' credentials this machine lacks (src/deploy/credentials.ts), and ends
# with what is left for the person. Without a terminal, or with --non-interactive, the credentials come from NEXUS_*
# variables instead. Safe to rerun: an existing config keeps its values and secrets, and gains only what is missing,
# an existing credential is left as it is, and a role that already runs a release keeps it unless --upgrade.
#   sudo deploy/install.sh --check [--node <device>]   checks the prerequisites and, once installed, the install, and changes nothing
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/release.sh
. "$repo/deploy/release.sh"

usage="usage: sudo deploy/install.sh [--check] [--node <control plane device> [--join <token>]] [--admit <device>]... [--add-node <device>=<deploy key digest>]... [--peer <device>]... [--dotfiles <git URL>] [--non-interactive] [--upgrade]
       sudo deploy/install.sh --join-token
       sudo deploy/install.sh --rotate claude|github [--non-interactive]"

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
memory_kib() { awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null; }
# The free KiB and the mount point of the filesystem that would hold $1.
free_space() {
  local path=$1
  while [ ! -e "$path" ]; do path=$(dirname "$path"); done
  df -Pk "$path" 2>/dev/null | awk 'NR == 2 { print $4, $6 }' | grep . || echo "0 $path"
}
# The systemd unit, or else the command, of each process that listens on TCP port $1, one a line, nothing when none
# does. A port can have several listeners, one an address, so each is named.
proc=/proc
port_listener() {
  local line pid unit
  while IFS= read -r line; do
    pid=$(sed -n 's/.*pid=\([0-9]*\).*/\1/p' <<<"$line")
    unit=$(sed -n 's|.*/\([^/]*\.service\)$|\1|p' "$proc/$pid/cgroup" 2>/dev/null | head -n 1 || true)
    echo "${unit:-$(cat "$proc/$pid/comm" 2>/dev/null || echo "a process ss could not name")}"
  done < <(ss -Hltnp "sport = :$1" 2>/dev/null || true)
}
ports_readable() { command -v ss >/dev/null; }
user_home() { getent passwd "$1" | cut -d: -f6 || true; }
prefix_entries() { ls -A "$prefix" 2>/dev/null; }
unit_state() { systemctl is-active "$1" 2>/dev/null || true; }
installed_roles() { ls "$prefix/deployer/roles" 2>/dev/null || true; }
installed_check() { PATH=$service_path node "$repo/src/deploy/installed.ts" "$prefix" "$etc"; }
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

# Mints a join token from the control plane's release, which holds the registry code and its dependencies.
mint_join_token() {
  [ "$(uid)" = 0 ] || fail "only root on the control plane's machine mints a join token: sudo deploy/install.sh --join-token"
  control_config_exists || fail "this machine runs no control plane. Run --join-token on the control plane's machine"
  [ -f "$prefix/control-current/src/control/join-token.ts" ] \
    || fail "the control plane here is older than join tokens. Upgrade it with nexus deploy, then mint the token"
  PATH=$service_path node "$prefix/control-current/src/control/join-token.ts" "$etc/control.json"
}

misses=()
# $1 says what is missing, and each further argument is one line of its fix.
miss() {
  local entry="- $1" line
  shift
  for line in "$@"; do entry+=$'\n'"    $line"; done
  misses+=("$entry")
}

warnings=()
warn() {
  local entry="- $1" line
  shift
  for line in "$@"; do entry+=$'\n'"    $line"; done
  warnings+=("$entry")
}

# Reads `tailscale status --json` on stdin without Node, which a first run may lack, and prints the settings the
# prerequisites need, one per line: `backend <BackendState>`, `magicdns true|false`, `certdomain <domain>` for each of
# CertDomains, and `keyexpiry <time>` when this node's key expires. It walks the JSON's tokens, so neither indentation
# nor the order of keys matters, and text that is not JSON prints nothing, as a tailscale that is not running.
tailnet_settings() {
  awk 'BEGIN { RS = "\001" }
  function value(v) {
    if (depth == 1 && key[1] == "BackendState") print "backend " v
    else if (depth == 2 && kind[2] == "{" && key[1] == "CurrentTailnet" && key[2] == "MagicDNSEnabled") print "magicdns " v
    else if (depth == 2 && kind[2] == "[" && key[1] == "CertDomains") print "certdomain " v
    else if (depth == 2 && kind[2] == "{" && key[1] == "Self" && key[2] == "KeyExpiry") print "keyexpiry " v
  }
  {
    s = $0; n = length(s); depth = 0
    for (i = 1; i <= n; i++) {
      c = substr(s, i, 1)
      if (c == "\"") {
        str = ""
        for (i++; i <= n && (c = substr(s, i, 1)) != "\""; i++) {
          if (c == "\\") { i++; c = substr(s, i, 1) }
          str = str c
        }
        for (j = i + 1; substr(s, j, 1) ~ /[ \t\r\n]/; j++) {}
        if (substr(s, j, 1) == ":") { key[depth] = str; i = j } else value(str)
      } else if (c == "{" || c == "[") { depth++; kind[depth] = c; key[depth] = "" }
      else if (c == "}" || c == "]") depth--
      else if (c ~ /[a-z0-9-]/) {
        for (j = i; substr(s, j + 1, 1) ~ /[a-zA-Z0-9.+-]/; j++) {}
        value(substr(s, i, j - i + 1)); i = j
      }
    }
  }'
}

# Records every prerequisite this machine misses for the role, control or node, and changes nothing. $2 is the command
# line to rerun.
check_prerequisites() {
  local role=$1 rerun=$2 major qemu packages status settings manager kib
  [ "$(uid)" = 0 ] || miss "The installer changes the system, so it runs as root." "$rerun"
  if [ "$(kernel)" != Linux ] || ! systemd_booted; then
    miss "Nexus runs as systemd services, and this machine is not a Linux booted with systemd." "Install on a Linux that boots with systemd, such as Debian 12, Ubuntu 24.04 or Fedora 42."
  fi

  # images/pylon/gondolin.json and the image's Dockerfile pin every pylon to x86_64.
  [ "$(machine)" = x86_64 ] \
    || miss "Pylons run x86_64 images under KVM, and this machine is $(machine)." "Install on an x86_64 Linux machine."

  # A machine sold with 8 GiB reports a little less, since the firmware and the kernel keep some of it.
  # An installed machine reruns the installer to recover, so what it has outgrown warns rather than stops that rerun.
  local short=miss
  ! prefix_entries | grep -x releases >/dev/null || short=warn
  kib=$(memory_kib) || kib=0
  [ "${kib:-0}" -ge $((7680 * 1024)) ] \
    || $short "Nexus needs at least 8 GiB of memory, and this machine has $((${kib:-0} / 1024)) MiB." "Install on a machine, or give this VM, at least 8 GiB of memory."

  manager=$(package_manager)
  major=$(node_major)
  local node_fix
  case $manager in
    apt) node_fix="curl -fsSL https://deb.nodesource.com/setup_26.x | sudo bash - && sudo apt-get install -y nodejs" ;;
    dnf) node_fix="curl -fsSL https://rpm.nodesource.com/setup_26.x | sudo bash - && sudo dnf install -y nodejs" ;;
    *) node_fix="Install Node 26 from https://nodejs.org/en/download into /usr/local." ;;
  esac
  if [ "$major" = none ] || [ "$major" -lt 26 ]; then
    miss "Node 26 or newer must be in $service_path, found $major." "$node_fix"
  elif ! in_service_path npm; then
    # NodeSource's package and nodejs.org's archive both bring npm, so it goes missing only with a Node from elsewhere.
    miss "npm must be in $service_path, since each release is built with npm ci. Node 26 came without it." "$node_fix"
  fi
  if ! in_service_path git; then
    case $manager in
      apt) packages="sudo apt-get install -y git" ;;
      dnf) packages="sudo dnf install -y git" ;;
      *) packages="Install git so that it is in $service_path." ;;
    esac
    miss "git must be in $service_path. The deployer fetches each release with it." "$packages"
  fi

  qemu=qemu-system-x86_64
  if ! in_service_path "$qemu" || ! in_service_path qemu-img; then
    case $manager in
      apt) packages="sudo apt-get install -y qemu-system-x86 qemu-utils" ;;
      dnf) packages="sudo dnf install -y $qemu-core qemu-img" ;;
      *) packages="Install QEMU so that $qemu and qemu-img are in $service_path." ;;
    esac
    miss "Pylons are QEMU VMs, and $qemu or qemu-img is not in $service_path." "$packages"
  fi
  if ! kvm_device; then
    miss "/dev/kvm is missing, so QEMU cannot run pylons with KVM." "Turn on hardware virtualization (Intel VT-x or AMD-V) in the firmware, then:" "sudo modprobe kvm_intel || sudo modprobe kvm_amd"
  elif [ "$(kvm_device_group)" != kvm ]; then
    miss "/dev/kvm does not belong to the kvm group, which the probe's user joins to run QEMU." "sudo groupadd --system --force kvm && sudo udevadm trigger --name-match=kvm"
  fi

  # `nexus nodes` marks a node with under 20 GiB free, and pylons, their image and the releases live here.
  local path free mount mounts=" "
  for path in /var/lib/nexus "$prefix"; do
    read -r free mount <<<"$(free_space "$path")"
    [[ $mounts != *" $mount "* ]] || continue
    mounts+="$mount "
    [ "${free:-0}" -ge $((20 * 1024 * 1024)) ] \
      || $short "Nexus needs at least 20 GiB free on $mount, which holds $path, and it has $((${free:-0} / 1024 / 1024)) GiB." "Free space on $mount, or give it a larger disk."
  done

  local port listener want ports=(7480 7481)
  [ "$role" != control ] || ports=(7470 7443 "${ports[@]}")
  if ports_readable; then
    for port in "${ports[@]}"; do
      case $port in 7470|7443) want=nexus-control.service ;; *) want=nexus-probe.service ;; esac
      while IFS= read -r listener; do
        [ -z "$listener" ] || [ "$listener" = "$want" ] \
          || miss "Port $port is taken by $listener, and Nexus's $want listens on it." "sudo ss -ltnp 'sport = :$port' names the process. Stop it, or move it to another port."
      done <<<"$(port_listener "$port")"
    done
  else
    warn "ss is missing, so ports ${ports[*]} were not checked. A service already on one stops Nexus's from starting." "Install iproute2, which brings ss, and check again"
  fi

  local user home
  for user in nexus:/var/lib/nexus nexus-control:/var/lib/nexus-control; do
    home=$(user_home "${user%%:*}")
    [ -z "$home" ] || [ "$home" = "${user#*:}" ] \
      || miss "A user ${user%%:*} exists with home $home, so other software made it, and Nexus would run as it." "Remove the software that made it, then: sudo userdel ${user%%:*}"
  done
  if [ -n "$(prefix_entries)" ] && ! prefix_entries | grep -x releases >/dev/null; then
    miss "$prefix holds files and no releases directory, so other software put them there." "Remove that software, or move its files aside: sudo mv $prefix $prefix.other"
  fi

  if ! in_service_path tailscale; then
    miss "Tailscale is not installed in $service_path. Nexus reaches its nodes and callers over the tailnet." "curl -fsSL https://tailscale.com/install.sh | sh" "sudo tailscale up"
  else
    settings=$(status=$(tailscale_status) && tailnet_settings <<<"$status" || true)
    if ! grep -qx 'backend Running' <<<"$settings"; then
      miss "Tailscale is not running and logged in." "sudo systemctl enable --now tailscaled && sudo tailscale up"
    else
      grep -qx 'magicdns true' <<<"$settings" \
        || miss "MagicDNS is off. Nodes and preview URLs are named by MagicDNS." "Turn on MagicDNS at https://login.tailscale.com/admin/dns"
      grep -q '^certdomain ' <<<"$settings" \
        || miss "HTTPS certificates are off. Previews and the dashboard are served over HTTPS." "Turn on HTTPS Certificates at https://login.tailscale.com/admin/dns"
      local expiry
      expiry=$(sed -n 's/^keyexpiry //p' <<<"$settings")
      [ -z "$expiry" ] \
        || warn "This machine's Tailscale key expires at $expiry. Then it leaves the tailnet, and Nexus loses it until someone logs it in again." "Turn off key expiry for this machine at https://login.tailscale.com/admin/machines"
    fi
  fi

  [ "$role" = control ] || return 0
  if ! tailscaled_environment | grep -qx 'TS_PERMIT_CERT_UID=nexus-control'; then
    miss "tailscaled does not let nexus-control fetch the dashboard's certificate. Restarting tailscaled drops tailnet connections for a moment." \
      "sudo mkdir -p /etc/systemd/system/tailscaled.service.d" \
      "printf '[Service]\\nEnvironment=TS_PERMIT_CERT_UID=nexus-control\\n' | sudo tee /etc/systemd/system/tailscaled.service.d/nexus-cert.conf >/dev/null" \
      "sudo systemctl daemon-reload && sudo systemctl restart tailscaled"
  fi
}

# Records each unit of the installed roles that is not as it should be: the services and timers running, and the
# oneshot services not failed.
check_units() {
  local roles=$1 unit state
  local units=(nexus-deployer.timer nexus-deployer.path)
  [[ $roles != *control* ]] || units+=(nexus-control.service nexus-backup.timer)
  [[ $roles != *probe* ]] || units+=(nexus-probe.service)
  for unit in "${units[@]}"; do
    state=$(unit_state "$unit")
    [ "$state" = active ] \
      || miss "$unit is ${state:-unknown to systemd}, and should be running." "sudo systemctl start $unit, and journalctl -u $unit -n 50 says why it stopped"
  done
  for unit in nexus-deployer.service nexus-backup.service; do
    [ "$unit" != nexus-backup.service ] || [[ $roles == *control* ]] || continue
    [ "$(unit_state "$unit")" != failed ] \
      || miss "$unit failed its last run." "journalctl -u $unit -n 50 says why"
  done
}

# The prerequisites and, on an installed machine, its units, links and configs. It changes nothing. An installed machine
# without the control role is a node, whatever the arguments say.
check_machine() {
  local role=$1 rerun=$2 roles found
  roles=$(installed_roles)
  [ -z "$roles" ] || [[ $roles == *control* ]] || role=node
  check_prerequisites "$role" "$rerun"
  # Without root the install's files cannot be read, and the root miss already says to rerun with sudo.
  if [ -n "$roles" ] && [ "$(uid)" = 0 ]; then
    check_units "$roles"
    mapfile -d '' -t found < <(installed_check)
    misses+=("${found[@]}")
    wait $! || miss "src/deploy/installed.ts could not check the install's links and configs." "See what it says: sudo node $repo/src/deploy/installed.ts $prefix $etc"
  fi
  [ ${#warnings[@]} = 0 ] || { echo "Warnings:" >&2; printf '%s\n' "${warnings[@]}" >&2; }
  if [ ${#misses[@]} -gt 0 ]; then
    echo "This machine has ${#misses[@]} problem(s). --check changed nothing. Fix each, then check again:" >&2
    printf '%s\n' "${misses[@]}" >&2
    exit 1
  fi
  if [ -n "$roles" ]; then
    echo "Every prerequisite holds, and the installed $(echo $roles) role(s) run as they should. --check changed nothing."
  else
    echo "Every prerequisite holds. Nexus is not installed here yet. --check changed nothing."
  fi
}

main() {
  local role=control check=no i
  local args=("$@")
  if [ "${1:-}" = --join-token ]; then
    [ $# = 1 ] || fail "--join-token takes no other argument. $usage"
    mint_join_token
    return
  fi
  if [ "${1:-}" = --rotate ]; then
    [ "$(uid)" = 0 ] || fail "only root replaces a stored credential: sudo deploy/install.sh --rotate ${2:-claude|github}"
    [ $# -ge 2 ] || fail "--rotate names what to replace, claude or github. $usage"
    PATH=$service_path:$PATH node "$repo/src/deploy/setup.ts" rotate "${@:2}"
    return
  fi
  # Only what the prerequisites depend on. setup.ts install refuses the arguments that are wrong.
  for ((i = 0; i < $#; i++)); do
    case ${args[i]} in
      --rotate|--rotate=*) fail "--rotate comes first: sudo deploy/install.sh --rotate claude|github [--non-interactive]" ;;
      --node|--node=*|--join|--join=*) role=node ;;
      --check) check=yes ;;
      -h|--help) echo "$usage"; exit 0 ;;
    esac
  done

  if [ $check = yes ]; then
    check_machine "$role" "sudo deploy/install.sh${args[*]:+ ${args[*]}}"
    return
  fi
  check_prerequisites "$role" "sudo deploy/install.sh${args[*]:+ ${args[*]}}"
  [ ${#warnings[@]} = 0 ] || { echo "Warnings:" >&2; printf '%s\n' "${warnings[@]}" >&2; }
  if [ ${#misses[@]} -gt 0 ]; then
    echo "This machine is missing ${#misses[@]} prerequisite(s). Nothing was changed. Fix each, then rerun:" >&2
    printf '%s\n' "${misses[@]}" >&2
    exit 1
  fi

  # The credentials step runs runuser and chown, which live in the sbin directories the units' PATH lacks.
  PATH=$service_path:$PATH node "$repo/src/deploy/setup.ts" install --package-manager "$(package_manager)" "$@"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
