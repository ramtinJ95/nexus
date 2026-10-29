#!/usr/bin/env bash
# Runs the checkout's deploy/install-deployer.sh as root over a bootstrap an earlier install left, tests included, then
# lists what the bootstrap holds and runs its worker with no node_modules. It runs in a private mount namespace, with a
# tmpfs on /opt/nexus and a copy of /etc, so nothing outside it changes. systemctl only logs.
#
#   sudo env PATH="$PATH" unshare --mount --propagation private bash docs/verification/deploy-worker/bootstrap.sh <checkout>
set -euo pipefail
tree=$(cd "$1" && pwd)
scratch=$(mktemp -d)
cp -a /etc/. "$scratch/etc"
mount --bind "$scratch/etc" /etc
mount -t tmpfs none /opt/nexus
mkdir -p /etc/nexus /etc/systemd/system "$scratch/bin"
printf '{"controlUrl":"http://127.0.0.1:9/","controlNodeId":"nCONTROLNODE","token":"%s","drainTimeoutMs":0,"healthTimeoutMs":1000}\n' "$(printf 'a%.0s' {1..64})" > /etc/nexus/deployer.json
printf '#!/bin/sh\necho "systemctl $*"\n' > "$scratch/bin/systemctl"
chmod 0755 "$scratch/bin/systemctl"
mkdir -p /opt/nexus/deployer/bootstrap/src/deploy
cp "$tree"/src/deploy/*.test.ts /opt/nexus/deployer/bootstrap/src/deploy/
echo "before: an earlier bootstrap holds $(find /opt/nexus/deployer/bootstrap -name '*.test.ts' | wc -l) test files"
echo "$ install-deployer.sh control probe"
PATH="$scratch/bin:$PATH" bash "$tree/deploy/install-deployer.sh" control probe 2>&1 | sed 's/^/  /'
echo "after: /opt/nexus/deployer"
(cd /opt/nexus/deployer && find . -mindepth 1 -printf '  %M %u:%g %p\n' | LC_ALL=C sort -k3)
echo "$ node bootstrap/src/deploy/worker.ts --check, as root, with no node_modules"
(cd /opt/nexus/deployer/bootstrap && env -i PATH="$PATH" node src/deploy/worker.ts --check 2>&1 | grep -m1 -E '^[A-Za-z]*Error' | sed 's/^/  /') || true
