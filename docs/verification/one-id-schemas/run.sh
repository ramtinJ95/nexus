#!/bin/sh
# Usage: docs/verification/one-id-schemas/run.sh <git ref>
# Runs the probe's and the control plane's real entry points, and garbage(), from a checkout of <ref>.
set -u
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
ref=$1
work=$(mktemp -d)
tree=$work/tree
trap 'git -C "$repo" worktree remove --force "$tree"; rm -rf "$work"' EXIT
git -C "$repo" worktree add -q --detach "$tree" "$ref"
ln -s "$repo/node_modules" "$tree/node_modules"
(cd "$tree" && npm run build > /dev/null)
# Runs an entry point from the checkout and prints its exit code and the lines that say why it stopped.
entry() {
  echo "\$ node $1 $2"
  (cd "$tree" && timeout 20 node "$1" "$work/$2" > "$work/out" 2>&1)
  echo "exit $?"
  grep -E '^(Error|✖|  →|probe |nexus control)' "$work/out" | sed -e "s|$work|\$WORK|g"
}

echo "# $ref is $(git -C "$tree" rev-parse --short HEAD), on node $(node --version)"
touch "$work/secrets.env" && chmod 600 "$work/secrets.env"
for name in rj-firebat "$(printf 'n%.0s' $(seq 63))" "$(printf 'n%.0s' $(seq 64))" auto; do
  echo
  echo "## node name \"$name\" (${#name} characters)"
  cat > "$work/probe.json" <<JSON
{ "node": "$name", "listen": { "host": "100.64.0.7" }, "auth": { "controlPlane": "nControl1CNTRL", "peers": [] },
  "backend": { "kind": "docker", "images": { "img-0123456789ab": "nexus-pylon:verify" } }, "secretsFile": "$work/secrets.env" }
JSON
  sed -e "s|\"name\": \"rj-firebat\"|\"name\": \"$name\"|" -e "s|/var/lib/nexus-control|$work|g" "$tree/deploy/control.example.json" > "$work/control.json"
  entry src/probe/main.ts probe.json
  entry src/control/main.ts control.json
done

echo
echo "## garbage() over an artifact store with malformed directory names"
node "$here/garbage.ts" "$tree"

echo
echo "## the branch's regression tests against $ref's code"
cp "$repo/src/control/main.test.ts" "$tree/src/control/main.test.ts"
cp "$repo/src/images.test.ts" "$tree/src/images.test.ts"
(cd "$tree" && node --test --test-name-pattern='node name exactly when|no image or template ID' src/control/main.test.ts src/images.test.ts 2>&1 | grep -E '^(✔|✖|ℹ (pass|fail))' | sed 's/ ([0-9.]*ms)$//')
