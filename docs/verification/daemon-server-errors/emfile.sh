#!/bin/sh
# emfile.sh: whether running out of file descriptors reaches a listening http.Server's 'error' event. A server on
# a Unix socket counts its 'error' events while prlimit drops its open-file limit to 3, below what it already holds,
# and a client connects. The limit is then restored and a client connects again.
set -eu
work="$(mktemp -d /tmp/nxe-XXXXXX)"
trap 'rm -rf "$work"' EXIT
node --input-type=module -e '
import http from "node:http";
let errors = 0;
const server = http.createServer((req, res) => res.end("ok\n"));
server.on("error", (error) => console.log(`server error ${++errors}: ${error.code} ${error.syscall}`));
server.listen(process.argv[1], () => console.log("listening"));
setTimeout(() => { console.log(`server errors: ${errors}`); process.exit(0); }, 4000);
' "$work/s.sock" &
pid=$!
while [ ! -S "$work/s.sock" ]; do sleep 0.05; done
prlimit --pid "$pid" --nofile=3:1024
echo "open-file limit: $(prlimit --pid "$pid" --nofile --noheadings --output SOFT | tr -d " ")"
curl -s -m 1 --unix-socket "$work/s.sock" http://server/ || echo "client with the limit at 3: no answer (curl exit $?)"
prlimit --pid "$pid" --nofile=1024:1024
printf "client with the limit restored: %s" "$(curl -s -m 1 --unix-socket "$work/s.sock" http://server/)"
echo
wait "$pid"
