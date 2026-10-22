#!/usr/bin/env bash
set -euo pipefail
cd /Users/ramtin/personal/nexus
for script in spikes/s*.sh; do bash -n "$script"; done
for script in spikes/s*.mjs; do node --check "$script"; done
git diff --check
test -z "$(git remote)"
echo 'LOCAL_SYNTAX_AND_DIFF_CHECK_PASS (not runtime conformance)'
