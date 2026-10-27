#!/bin/sh
# run.sh <git ref>: runs that ref's src/pylon-vm/daemon.ts, as a real controller process over an instance directory,
# with this branch's fake-runtime.ts in place of the VM. It fails two accepts on the controller's server after it
# listens, inspecting the instance before and after each, then sends SIGTERM if the controller still runs, and
# prints the controller's log, its exit code and what it left in the instance directory.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
ref="$1"
work="$(mktemp -d /tmp/nxd-XXXXXX)"
trap 'git -C "$repo" worktree remove --force "$work/tree" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
git -C "$repo" worktree add --detach --quiet "$work/tree" "$ref"
cp "$repo/src/pylon-vm/fake-runtime.ts" "$work/tree/src/pylon-vm/fake-runtime.ts"
ln -s "$repo/node_modules" "$work/tree/node_modules"
dir="$work/i/pylon-t1"
mkdir -p -m 700 "$work/i" "$dir"
echo '{"version":1,"name":"pylon-t1","config":{},"createdAt":"2026-10-27T00:00:00.000Z","labels":{}}' > "$dir/record.json"
echo '{"prepare":false}' > "$dir/intent.json"
echo "ref: $ref ($(git -C "$repo" rev-parse --short "$ref")), node $(node --version)"
echo '{"resources":{"cpus":1,"memoryGiB":1},"allowedHosts":[],"secrets":{},"ssh":null,"files":[],"hooks":[],"publicUrls":{},"hostBridge":null}' |
	node --import "$work/tree/src/pylon-vm/fake-runtime.ts" "$work/tree/src/pylon-vm/daemon.ts" "$dir" > "$work/controller.log" 2>&1 &
pid=$!
while [ ! -S "$dir/control.sock" ] && kill -0 "$pid" 2>/dev/null; do sleep 0.05; done
inspect() {
	reply="$(curl -s -m 2 --unix-socket "$dir/control.sock" -d '{"action":"inspect","name":"pylon-t1"}' http://controller/)" && echo "inspect $1: $reply" || echo "inspect $1: no answer (curl exit $?)"
}
alive() { kill -0 "$pid" 2>/dev/null && echo "controller $1: alive" || echo "controller $1: gone"; }
inject() {
	kill -USR2 "$pid" 2>/dev/null || { echo "accept error $1: controller already gone"; return; }
	n=0
	while ! grep -q "injected accept error $1" "$work/controller.log" && [ $n -lt 40 ]; do sleep 0.05; n=$((n + 1)); done
	sleep 0.2
	echo "accept error $1: injected"
}
inspect "before any error"
inject 1
alive "after accept error 1"
inspect "after accept error 1"
inject 2
alive "after accept error 2"
inspect "after accept error 2"
if kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid"; echo "sent SIGTERM"; fi
code=0
wait "$pid" || code=$?
echo "controller exit code: $code"
echo "left in the instance directory: $(cd "$dir" && ls | grep -v -e record.json -e intent.json | tr '\n' ' ')"
echo "controller.log:"
sed "s|$work|<work>|g; s/^/  /" "$work/controller.log"
