#!/usr/bin/env bash
# Mac-side transport: reuse one connection per home host; no SSH config edits.
set -euo pipefail
host=${1:?host required}; shift
case "$host" in rj-firebat|infra-testbench) ;; *) echo 'Unexpected host' >&2; exit 2;; esac
exec ssh -o BatchMode=yes -o ConnectTimeout=15 \
  -o ProxyCommand='nc -X 5 -x localhost:1055 %h %p' \
  -o ControlMaster=auto -o ControlPath=/tmp/nx-%C \
  -o ControlPersist=60m "$host" "$@"
