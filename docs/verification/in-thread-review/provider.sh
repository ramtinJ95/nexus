#!/usr/bin/env bash
# What pi's openai-codex provider calls and needs, in a pylon without the person's login. Every credential here is
# fake and lives in a scratch PI_CODING_AGENT_DIR, so ~/.pi/agent is untouched.
set -u
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

auth() {
  node --input-type=module - "$dir" "$1" "${2:-fakesignature}" <<'EOF'
import { writeFileSync } from "node:fs";
const [dir, expiresIn, signature] = process.argv.slice(2);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const access = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-fake" }, exp: 4102444800 })}.${signature}`;
writeFileSync(`${dir}/auth.json`, JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "fake-refresh", expires: Date.now() + Number(expiresIn) * 1000, accountId: "acct-fake" } }));
EOF
}

ask() {
  echo "\$ pi -p --model openai-codex/gpt-6-astra   # $1"
  (cd / && timeout 120 env PI_CODING_AGENT_DIR="$dir" pi -p --model openai-codex/gpt-6-astra --thinking high "Say ok" </dev/null 2>&1 | tail -3)
  echo
}

echo "pi $(pi --version), $(date -u +%FT%TZ)"
echo
echo '{}' >"$dir/auth.json"
ask "no login"
auth 3600
ask "an unexpired access token"
auth -60
ask "an expired access token, so pi refreshes first"
auth 3600 "0123456789abcdef0123456789abcdef.codex_token"
ask "a signature shaped like Gondolin's default placeholder, <marker>.<name>"
auth 3600
echo '{"providers":{"openai-codex":{"baseUrl":"http://nexus.pylon/openai-codex"}}}' >"$dir/models.json"
ask "models.json points openai-codex at the probe's pylon API"
rm "$dir/models.json"

for host in chatgpt.com auth.openai.com api.openai.com; do
  echo "\$ curl https://$host/"
  curl -s "https://$host/" | head -c 120
  echo
done
