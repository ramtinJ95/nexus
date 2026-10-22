#!/usr/bin/env bash
# Run on the Mac. Stage a sparse gzip tar between SSH legs; no tailnet CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
case ${1:?forward or return} in
  forward) src=infra-testbench; dst=rj-firebat; archive=forward.tar.gz;;
  return) src=rj-firebat; dst=infra-testbench; archive=return.tar.gz;;
  *) exit 2;;
esac
echo "TRANSFER=$src->$dst ARCHIVE=$archive"
staged=$(mktemp "${TMPDIR:?}/nexus-s7-transfer.XXXXXX")
trap 'rm -f -- "$staged"' EXIT
TIMEFORMAT='TRANSFER_SECONDS=%3R'
time {
  bash spikes/s7-ssh.sh "$src" "cat \"\$HOME/nexus-spikes/s7/$archive\"" > "$staged"
  printf 'STAGED_BYTES='; wc -c < "$staged" | tr -d ' '
  printf 'STAGED_SHA256='; shasum -a 256 "$staged" | cut -d ' ' -f 1
  gzip -t "$staged"
  bash spikes/s7-ssh.sh "$dst" 'tar -xzf - -C "$HOME/nexus-spikes/s7"' < "$staged"
}
echo TRANSFER_EXIT=0
