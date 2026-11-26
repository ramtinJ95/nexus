#!/bin/sh
# Reruns the whole prototype: tops up the scratch repo's seed PRs from the host, then for each guard mode boots one
# Gondolin VM in a throwaway container and runs probes.mjs. The token goes in on the container's stdin, so it is never
# on a command line, in the container's env, or in a file. Usage, from anywhere: interrogate/guard-github/run.sh [A B off]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
modules=$(readlink -f "$here/../../node_modules")
cache="$here/../vm/cache-home"
[ -d "$cache/gondolin" ] || { mkdir -p "$cache"; cp -r --reflink=auto "$HOME/.cache/gondolin" "$cache/gondolin"; }
for mode in ${*:-A B off}; do
  WANT=${WANT:-14} "$here/seed.sh" >&2
  gh auth token | docker run --rm -i --name nexus-guard-github --device /dev/kvm --user "$(id -u):$(id -g)" \
    --memory 6g --cpus 6 -e HOME=/tmp -e XDG_CACHE_HOME=/work/interrogate/vm/cache-home -e GUARD="$mode" \
    -v "$here/..":/work/interrogate -v "$modules":/work/node_modules:ro \
    -w /work/interrogate/guard-github nexus-interrogate-gondolin:1 node "${SCRIPT:-probes.mjs}" 2>&1 | tee "$here/out-$mode.txt"
done
