#!/usr/bin/env bash
# Removes what deploy/install.sh and the deployer put on this machine. Run as root:
#   sudo deploy/uninstall.sh                     prints what it would do, and changes nothing
#   sudo deploy/uninstall.sh --yes               does it
#
# It refuses while a pylon's controller runs, because stopping the probe leaves them running (KillMode=process in
# nexus-probe.service), unless --stop-pylons, which waits for each controller to finish booting, then sends it SIGTERM
# so it stops its VM and saves its disk, as a pause does. --keep-state keeps /var/lib/nexus, /var/lib/nexus-control, /var/lib/nexus-backup and
# /etc/nexus, and the users that own them, whose numeric IDs the state's files carry, so a reinstall picks up where
# this one stopped. /var/backups/nexus goes only with --remove-backups. Safe to rerun: each run removes only what is
# still there, and ends with what remains.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/release.sh
. "$repo/deploy/release.sh"

usage="usage: sudo deploy/uninstall.sh [--yes] [--stop-pylons] [--keep-state] [--remove-backups]"

# In the order they stop: the deployer first, so it cannot start the others again, and the probe last.
units=(nexus-deployer.path nexus-deployer.timer nexus-deployer.service nexus-backup.timer nexus-backup.service nexus-control.service nexus-probe.service)
users=(nexus nexus-control)
unit_dir=/etc/systemd/system
dropin=$unit_dir/tailscaled.service.d/nexus-cert.conf
state_dirs=(/var/lib/nexus /var/lib/nexus-control /var/lib/nexus-backup)
backups=/var/backups/nexus
# How long --stop-pylons waits for the controllers' stops. The probe's own unit gives its pauses 150 s.
stop_wait=180

uid() { id -u; }
has_tailscale() { PATH=$service_path command -v tailscale >/dev/null; }
# Each pylon's controller: node running src/pylon-vm/daemon.ts as the probe's user. Its VM runs as its child.
controllers() { pgrep -u nexus -f '/src/pylon-vm/daemon\.ts' 2>/dev/null || true; }
# The instance directory the controller $1 runs, the argument after daemon.ts.
controller_dir() { tr '\0' '\n' < "/proc/$1/cmdline" 2>/dev/null | sed -n '/\/src\/pylon-vm\/daemon\.ts$/{n;p;q}'; }
# The controllers still booting. A controller handles SIGTERM, by stopping its VM and saving its disk, only once it
# listens on control.sock, and before that SIGTERM ends it with nothing saved.
booting() {
  local pid
  for pid in $(controllers); do [ -e "$(controller_dir "$pid")/control.sock" ] || echo "$pid"; done
}

# The https ports whose serve entry, in the `tailscale serve status --json` on stdin, is Nexus's: its only handler
# proxies / to the probe's preview gateway, as src/probe/serve.ts decides. Every other entry is left alone. A
# probe.json with no previews, or none at all once /etc/nexus is gone, means the probe published none. /etc/nexus stays
# until tailscaled answers, so a rerun still knows the gateway.
serve_ports() {
  PATH=$service_path node -e '
    const fs = require("fs");
    let port;
    try { port = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).previews?.gatewayPort } catch {}
    const config = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    for (const [hostPort, web] of Object.entries(port === undefined ? {} : config.Web ?? {})) {
      const handlers = Object.entries(web.Handlers ?? {});
      if (handlers.length === 1 && handlers[0][0] === "/" && handlers[0][1].Proxy === `http://127.0.0.1:${port}`) console.log(hostPort.slice(hostPort.lastIndexOf(":") + 1));
    }' "$etc/probe.json"
}
# Whether tailscaled's operator is the probe's user, which deploy/release.sh made it.
operator_is_nexus() {
  PATH=$service_path tailscale debug prefs | PATH=$service_path node -e '
    process.exit(JSON.parse(require("fs").readFileSync(0, "utf8")).OperatorUser === "nexus" ? 0 : 1)'
}

# Everything Nexus puts on a machine, one `<kind> <name>` per line, in the order it goes.
inventory() {
  local unit user dir ports port
  for unit in "${units[@]}"; do echo "unit $unit"; done
  echo "pylons controllers"
  if has_tailscale; then
    if ports=$(PATH=$service_path tailscale serve status --json 2>/dev/null | serve_ports); then
      for port in $ports; do echo "serve $port"; done
      echo "operator nexus"
    else
      echo "unread -"
    fi
  fi
  echo "dropin $dropin"
  echo "dir $prefix"
  for user in "${users[@]}"; do echo "user $user"; done
  echo "dir $etc"
  for dir in "${state_dirs[@]}"; do echo "dir $dir"; done
  echo "dir $backups"
}

present() {
  case $1 in
    unit) [ -e "$unit_dir/$2" ] ;;
    pylons) [ -n "$(controllers)" ] ;;
    serve|unread) return 0 ;;
    operator) operator_is_nexus ;;
    dropin|dir) [ -e "$2" ] || [ -L "$2" ] ;;
    user) id "$2" >/dev/null 2>&1 || getent group "$2" >/dev/null ;;
  esac
}

# Why the flags keep the thing, or nothing when this run removes it.
kept_by() {
  if [ "$1 $2" = "dir $backups" ]; then
    $remove_backups || echo "kept without --remove-backups"
    return 0
  fi
  if [ "$1 $2" = "dir $etc" ] && $tailscale_unread; then
    echo "kept until tailscaled answers, since probe.json names the gateway whose serve entries are Nexus's"
    return 0
  fi
  $keep_state || return 0
  [ "$1" = user ] || [ "$1 $2" = "dir $etc" ] || [[ "$1" = dir && " ${state_dirs[*]} " = *" $2 "* ]] || return 0
  echo "kept by --keep-state"
}

describe() {
  case $1 in
    unit) echo "stop, disable and remove $2" ;;
    pylons) echo "stop the pylons' controllers $(controllers | tr '\n' ' ')with SIGTERM, once each has booted, which saves each VM's disk, and wait up to $stop_wait s" ;;
    serve) echo "remove the tailscale serve entry on https port $2" ;;
    operator) echo "unset tailscaled's operator, nexus" ;;
    unread) echo "leave tailscale's serve entries and operator, which could not be read. Rerun once tailscaled runs" ;;
    dropin) echo "remove $2, which lets nexus-control fetch the dashboard's certificate. tailscaled keeps the permit until it next restarts" ;;
    user) echo "remove the user and group $2, and with them its membership of other groups, such as kvm and docker" ;;
    dir) echo "remove $2" ;;
  esac
}

remove() {
  local pid until=$((SECONDS + stop_wait))
  case $1 in
    unit) systemctl disable --now "$2"; rm -f "$unit_dir/$2"; systemctl daemon-reload; systemctl reset-failed "$2" 2>/dev/null || true ;;
    pylons)
      # One the probe started after main's check, before it stopped.
      $stop_pylons || fail "the pylons' controllers $(controllers | tr '\n' ' ')started after the check. Rerun with --stop-pylons, or delete the threads first"
      while [ -n "$(booting)" ] && [ "$SECONDS" -lt "$until" ]; do sleep 1; done
      [ -z "$(booting)" ] || fail "the controllers $(booting | tr '\n' ' ')still boot after $stop_wait s, and SIGTERM would end them before they can save their disks. Rerun once they run"
      for pid in $(controllers); do kill -TERM "$pid" 2>/dev/null || true; done
      while [ -n "$(controllers)" ] && [ "$SECONDS" -lt "$until" ]; do sleep 1; done
      [ -z "$(controllers)" ] || fail "the controllers $(controllers | tr '\n' ' ')still run after $stop_wait s. Rerun to wait for them again" ;;
    serve) PATH=$service_path tailscale serve "--https=$2" off ;;
    operator) PATH=$service_path tailscale set --operator= ;;
    unread) ;;
    dropin) rm -f "$2"; rmdir --ignore-fail-on-non-empty "$(dirname "$2")"; systemctl daemon-reload ;;
    user) if id "$2" >/dev/null 2>&1; then userdel "$2"; fi; if getent group "$2" >/dev/null; then groupdel "$2"; fi ;;
    dir) rm -rf --one-file-system "$2" ;;
  esac
}

main() {
  local yes=false stop_pylons=false keep_state=false remove_backups=false kind name why
  for arg in "$@"; do
    case $arg in
      --yes) yes=true ;;
      --stop-pylons) stop_pylons=true ;;
      --keep-state) keep_state=true ;;
      --remove-backups) remove_backups=true ;;
      -h|--help) echo "$usage"; return 0 ;;
      *) fail "unknown argument $arg. $usage" ;;
    esac
  done
  [ "$(uid)" = 0 ] || fail "the uninstall changes the system, so it runs as root: sudo deploy/uninstall.sh"
  if present pylons controllers && ! $stop_pylons; then
    fail "the pylons' controllers $(controllers | tr '\n' ' ')run, and stopping the probe leaves them running. Nothing was changed. Rerun with --stop-pylons, which stops each and saves its disk, or delete the threads first"
  fi

  $yes || echo "Nothing is changed without --yes. The uninstall would:"
  local plan tailscale_unread=false
  plan=$(inventory)
  [[ $'\n'$plan != *$'\n'"unread -"* ]] || tailscale_unread=true
  while read -r kind name; do
    if present "$kind" "$name" && [ -z "$(kept_by "$kind" "$name")" ]; then
      echo "- $(describe "$kind" "$name")"
      if $yes; then remove "$kind" "$name"; fi
    fi
  done <<<"$plan"

  if $yes; then echo "What remains of Nexus here:"; else echo "What would remain:"; fi
  local left=0
  while read -r kind name; do
    if present "$kind" "$name"; then
      why=$(kept_by "$kind" "$name")
      [ "$kind" != unread ] || name="tailscale's serve entries and operator, which could not be read"
      if $yes || [ -n "$why" ]; then echo "- $kind $name${why:+, $why}"; left=$((left + 1)); fi
    fi
  done <<<"$(inventory)"
  [ "$left" -gt 0 ] || echo "- nothing"
  echo "Node, QEMU, Docker and Tailscale stay installed, and this machine stays on the tailnet."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
