#!/bin/sh
# Takes one screenshot with the headless Chromium that @sparticuz/chromium bundles, since this pylon can reach npm but
# not Chrome's download hosts. Runs one at a time across callers, so several never exhaust the VM's memory.
#   design-gallery/shoot.sh <url> <out.png> [width] [height] [theme] [full=0|1]
set -e
here=$(cd "$(dirname "$0")" && pwd)
[ -d "$here/node_modules/@sparticuz/chromium" ] || (cd "$here" && npm ci --no-audit --no-fund >/dev/null)
# Chromium needs a writable /dev/shm, which a pylon boots without.
[ -w /dev/shm ] || sudo chmod 1777 /dev/shm
# Unpacks Chromium and its libraries into /tmp on the first run after a boot.
(cd "$here" && node -e 'import("@sparticuz/chromium").then((c) => c.default.executablePath())' >/dev/null)
# A C locale reads as en-US@posix, which Intl rejects, so the graphs would not draw.
exec flock /tmp/nexus-gallery-shoot.lock env LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LD_LIBRARY_PATH=/tmp/al2023/lib FONTCONFIG_PATH=/tmp/fonts node "$here/shoot.mjs" "$@"
