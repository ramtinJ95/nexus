#!/usr/bin/env bash
# Asks the control plane control.ts runs what the request boundary answers, with curl and the checkout's CLI, and
# prints each request and its answer. Run from the checkout under test with WORK set as control.ts has it.
set -uo pipefail
api=http://127.0.0.1:7470
ask() { echo "\$ $*"; "$@" 2>&1; echo " (exit $?)"; echo; }
nexus() { HOME="$WORK/home" NEXUS_URL= NEXUS_SOCKS= node src/cli/nexus.ts "$@"; }

ask curl -s -w '\nHTTP %{http_code}' "$api/v1/%zz"
touch "$WORK/stranger"
ask curl -s -w '\nHTTP %{http_code}' "$api/v1/%zz"
rm "$WORK/stranger"
ask curl -s -w '\nHTTP %{http_code}' -H 'Host: [zz' "$api/v1/projects"
ask curl -s -w '\nHTTP %{http_code}' -H 'Host: [zz' "$api/v1/whoami"
ask curl -s -w '\nHTTP %{http_code}' "$api/v1/no-such-route"
ask curl -s -w '\nHTTP %{http_code}' -X POST -H 'content-type: text/plain' -d '{}' "$api/v1/threads"
mkdir -p "$WORK/home"
ask nexus connect http://127.0.0.1:7470
ask stat -c '%a %n' "$WORK/home/.config/nexus/cli.json"
ask nexus --version
ask nexus show th-0123456789ab --json
ask nexus project add drinks --scratch --node verify-node --secret 'gh_token:api.github.com'
ask nexus project add drinks --scratch --node verify-node --secret 'GH_TOKEN:localhost'
ask nexus project add drinks --scratch --node verify-node --secret 'GH_TOKEN:api.github.com,github.com' --json
echo '{"url": "http://127.0.0.1:7470", "ssh": "x"}' > "$WORK/home/.config/nexus/cli.json"
ask nexus projects
