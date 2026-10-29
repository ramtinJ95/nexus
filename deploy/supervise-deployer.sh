#!/usr/bin/env bash
set -euo pipefail
prefix=/opt/nexus
# One lock covers both roles and their shared clone, including manual invocations.
exec 9>"$prefix/deployer/lock"
flock -n 9 || exit 0
run_worker() { timeout --kill-after=10s 900s /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin node "$1"; }
worker="$prefix/deployer-current/src/deploy/worker.ts"
if [ -e "$worker" ]; then
  if run_worker "$worker"; then exit 0; fi
  readlink "$prefix/deployer-current" > "$prefix/deployer/rejected"
  rm -f "$prefix/deployer-current"
fi
# This copy never changes during automatic upgrades. A broken worker cannot strand the node.
run_worker "$prefix/deployer/bootstrap/src/deploy/worker.ts"
