#!/usr/bin/env bash
set -euo pipefail
prefix=/opt/nexus
# One lock covers both roles and their shared clone, including manual invocations.
exec 9>"$prefix/deployer/lock"
flock -n 9 || exit 0
bootstrap="$prefix/deployer/bootstrap/src/deploy/worker.ts"
worker="$prefix/deployer-current/src/deploy/worker.ts"
if [ -e "$worker" ]; then
  if timeout --kill-after=10s 900s /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin node "$worker"; then exit 0; fi
  readlink "$prefix/deployer-current" > "$prefix/deployer/rejected"
  rm -f "$prefix/deployer-current"
fi
# This copy never changes during automatic upgrades. A broken worker cannot strand the node.
timeout --kill-after=10s 900s /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin node "$bootstrap"
