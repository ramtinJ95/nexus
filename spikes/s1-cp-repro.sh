#!/usr/bin/env bash
set -uo pipefail
export XDG_CACHE_HOME="$HOME/nexus-spikes/cache" PI_SANDBOX_HOME="$HOME/nexus-spikes/state" npm_config_cache="$HOME/nexus-spikes/npm-cache" TMPDIR="$HOME/nexus-spikes/tmp"
cd "$HOME/nexus-spikes"
ulimit -c 0
for runtime in node tools/node-v24.22.1-linux-x64/bin/node; do
  for mode in default verbatim; do
    echo "RUNTIME=$runtime MODE=$mode"
    "$runtime" s1-cp-repro.mjs "$mode"
    echo "EXIT=$?"
  done
done
if command -v strace >/dev/null 2>&1; then
  strace -f -e trace=%file -o logs/s1-cp-strace.txt node s1-cp-repro.mjs default
  echo "STRACE_EXIT=$?"
else
  echo 'STRACE_UNAVAILABLE; not installed; no syscall-level write claim'
fi
