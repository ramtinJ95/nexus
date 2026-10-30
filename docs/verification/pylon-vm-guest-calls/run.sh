#!/bin/sh
# run.sh <git ref>: prints the guest calls and controller requests of a probe exec, a services status and a client
# request, with that ref's src/pylon-vm modules over count.ts's simulated guest.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
ref="$1"
work="$(mktemp -d /tmp/nx-calls-XXXXXX)"
trap 'git -C "$repo" worktree remove --force "$work/tree" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
git -C "$repo" worktree add --detach --quiet "$work/tree" "$ref"
ln -s "$repo/node_modules" "$work/tree/node_modules"
echo "ref: $ref ($(git -C "$repo" rev-parse --short "$ref")), node $(node --version)"
node "$here/count.ts" "$work/tree/src/pylon-vm" 2>&1 | grep -v '^services: '
