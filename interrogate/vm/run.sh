#!/bin/sh
# Runs one interrogate/vm script against a real Gondolin VM, inside a throwaway container that has Node and QEMU,
# with the host's /dev/kvm. Usage, from the worktree root: interrogate/vm/run.sh <script.mjs> [ENV=value ...]
# The container sees the worktree's interrogate/ directory, the repository's node_modules read-only, and a private
# copy of Gondolin's guest assets. It is removed when the script ends.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
script=$1
shift
modules=$(readlink -f "$here/../../node_modules")
docker image inspect nexus-interrogate-gondolin:1 >/dev/null 2>&1 || docker build -q -t nexus-interrogate-gondolin:1 "$here" >/dev/null
if [ ! -d "$here/cache-home/gondolin" ]; then
  mkdir -p "$here/cache-home"
  if [ -d "$HOME/.cache/gondolin/images" ]; then cp -r --reflink=auto "$HOME/.cache/gondolin" "$here/cache-home/gondolin"; fi
fi
envs=""
for kv in "$@"; do envs="$envs -e $kv"; done
# shellcheck disable=SC2086
exec docker run --rm --name nexus-interrogate-vm --device /dev/kvm --user "$(id -u):$(id -g)" \
  --add-host bench.test:127.0.0.1 --add-host not-allowed.test:127.0.0.1 \
  --memory 6g --cpus 6 \
  -e HOME=/tmp/home -e XDG_CACHE_HOME=/work/interrogate/vm/cache-home $envs \
  -v "$here/..":/work/interrogate -v "$modules":/work/node_modules:ro \
  -w /work/interrogate/vm nexus-interrogate-gondolin:1 sh -c '
    mkdir -p /tmp/home /tmp/tls && cd /tmp/tls
    openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -subj "/CN=interrogate test CA" -days 2 2>/dev/null
    openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj "/CN=bench.test" 2>/dev/null
    printf "subjectAltName=DNS:bench.test\n" > ext.cnf
    openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem -days 2 -extfile ext.cnf 2>/dev/null
    cd /work/interrogate/vm
    node server.mjs /tmp/tls/leaf.key /tmp/tls/leaf.pem > /tmp/server.log 2>&1 &
    sleep 1
    export NODE_EXTRA_CA_CERTS=/tmp/tls/ca.pem CURL_CA_BUNDLE=/tmp/tls/ca.pem
    exec node '"$script"'
  '
