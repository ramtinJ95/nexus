#!/usr/bin/env bash
# pi with only the placeholder, the host side holding a fake token, and real requests to OpenAI. See README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
dir="$(mktemp -d)"
log="$here/run.log"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$dir"' EXIT
: >"$log"
say() { echo "$*" | tee -a "$log"; }

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=verify CA" -keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=api.openai.com" -keyout "$dir/leaf.key" -out "$dir/leaf.csr" 2>/dev/null
printf 'subjectAltName=DNS:api.openai.com,DNS:auth.openai.com,DNS:chatgpt.com\n' >"$dir/san"
openssl x509 -req -in "$dir/leaf.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial -days 1 -extfile "$dir/san" -out "$dir/leaf.crt" 2>/dev/null
cat "${NODE_EXTRA_CA_CERTS:-/dev/null}" "$dir/ca.crt" >"$dir/cas.crt"

value="nexus-verify-fake-$(openssl rand -hex 16)"
updated="nexus-verify-next-$(openssl rand -hex 16)"

# The host: started with the value in its environment, which it deletes, and fed updates on stdin.
host() {
  mkfifo "$dir/$1.in"
  env VERIFY_VALUE="$value" ${2:+VERIFY_HOLD_MS=$2} node "$here/host.mjs" "$repo" "$dir/leaf.key" "$dir/leaf.crt" "$log" <"$dir/$1.in" >"$dir/$1.out" &
  exec {fd}>"$dir/$1.in"
  eval "${1}_in=$fd"
  until test -s "$dir/$1.out"; do sleep 0.1; done
}
host plain
read -r port placeholder < <(head -1 "$dir/plain.out" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.port,o.placeholder)')

# The guest: a copy of this pylon's pi setup under a scratch HOME, with one unrelated login already in auth.json.
home="$dir/home"
mkdir -p "$home/.pi"
cp -a "$HOME/.pi/agent" "$home/.pi/agent"
echo '{"anthropic":{"type":"api_key","key":"unrelated-entry"}}' >"$home/.pi/agent/auth.json"
writer="$(cd "$repo" && node --input-type=module -e 'import { piChatgptLoginCommand } from "./src/pylon-vm-backend.ts"; process.stdout.write(piChatgptLoginCommand())')"
HOME="$home" NEXUS_CHATGPT_TOKEN="$placeholder" bash -c "$writer" | sed 's/^/boot hook: /' | tee -a "$log"
say "auth.json after the boot hook, tokens cut to 10 characters:"
node -e '
const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const e of Object.values(a)) for (const k of ["access", "key"]) if (typeof e[k] === "string") e[k] = e[k].slice(0, 10) + "…";
console.log(JSON.stringify(a, null, 2));' "$home/.pi/agent/auth.json" | tee -a "$log"

pi_run() {
  (cd / && HOME="$home" HTTPS_PROXY="http://127.0.0.1:$1" NODE_EXTRA_CA_CERTS="$dir/cas.crt" PI_OFFLINE=1 \
    timeout 120 pi -p --model "$2" "Say ok" </dev/null 2>&1 || true) | grep -v "^ */\|^$" | tail -3 | sed "s/$value/<the first value>/g; s/$updated/<the updated value>/g"
}

say
say "## 1. pi asks openai/gpt-6-astra, with only the placeholder"
pi_run "$port" openai/gpt-6-astra | tee -a "$log"

say
say "## 2. The host updates the value while pi's setup stays as it was"
echo "$updated" >&"$plain_in"
until grep -q updated "$dir/plain.out"; do sleep 0.1; done
pi_run "$port" openai/gpt-6-astra | tee -a "$log"

say
say "## 3. The placeholder sent to another allowed host"
curl -s --proxy "http://127.0.0.1:$port" --cacert "$dir/ca.crt" -H "Authorization: Bearer $placeholder" -o /dev/null -w "curl got HTTP %{http_code}\n" https://auth.openai.com/oauth/token | tee -a "$log"

say
say "## 4. openai-codex is not signed in"
pi_run "$port" openai-codex/gpt-6-astra | tee -a "$log"

say
say "## 5. Where the value is, while OpenAI's answer is held for 5 seconds"
host held 5000
read -r held_port held_placeholder < <(head -1 "$dir/held.out" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.port,o.placeholder)')
HOME="$home" NEXUS_CHATGPT_TOKEN="$held_placeholder" bash -c "$writer" >/dev/null
(cd / && HOME="$home" HTTPS_PROXY="http://127.0.0.1:$held_port" NODE_EXTRA_CA_CERTS="$dir/cas.crt" PI_OFFLINE=1 \
  timeout 120 pi -p --model openai/gpt-6-astra "Say ok" </dev/null >/dev/null 2>&1) &
pi_shell=$!
until grep -q holding "$dir/held.out"; do sleep 0.1; done
pi_pid="$(pgrep -P "$(pgrep -n -f 'timeout 120 pi -p --model openai/gpt-6-astra')")"
host_pid="$(pgrep -n -f "host.mjs $repo")"
needles="$(printf 'the value=%s\nthe placeholder=%s\n' "$value" "$held_placeholder")"
say "pi (pid $pi_pid):"
sudo python3 "$here/scan.py" "$pi_pid" <<<"$needles" | sed 's/^/  /' | tee -a "$log"
say "the host (pid $host_pid):"
sudo python3 "$here/scan.py" "$host_pid" <<<"$needles" | sed 's/^/  /' | tee -a "$log"
if grep -rqF "$value" "$home"; then say "the value is in a file under pi's HOME"; else say "no file under pi's HOME holds the value"; fi
wait "$pi_shell" || true
