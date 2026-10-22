#!/usr/bin/env bash
set -euo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache" TMPDIR="$HOME/nexus-spikes/tmp"
cd "$HOME/nexus-spikes"
node_modules/.bin/gondolin exec --sock "$1" -- sh -c 'ls -ld /etc/gondolin /etc/gondolin/mitm /etc/gondolin/mitm/ca.crt /run/gondolin /run/gondolin/ca-certificates.crt; runuser -u user -- sh -c "test -r /etc/gondolin/mitm/ca.crt; echo USER_MITM_CA_READABLE_EXIT=\$?; test -r /run/gondolin/ca-certificates.crt; echo USER_RUNTIME_CA_READABLE_EXIT=\$?"; grep gondolin /proc/mounts'
