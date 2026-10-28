import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact.ts";

test("every value the probe holds is redacted wherever it appears, longest first, and a value under 8 characters is not", () => {
  assert.equal(redact("a=sekrit-value-1 b=xsekrit-value-1-longerx c=abc", ["sekrit-value-1", "sekrit-value-1-longer", "abc"]),
    "a=[redacted] b=x[redacted]x c=abc");
});

test("credential shapes are redacted and keep what names them", () => {
  const cases: [string, string][] = [
    ["GH_TOKEN=GONDOLIN_SECRET_0123456789abcdef0123456789abcdef0123456789abcdef", "GH_TOKEN=[redacted]"],
    ["curl got GONDOLIN_SECRET_0123456789abcdef0123456789abcdef0123456789abcdef back", "curl got GONDOLIN_SECRET_[redacted] back"],
    ["sent 0123456789abcdef0123456789abcdef0123456789abcdef.gh_token upstream", "sent [redacted].gh_token upstream"],
    ["push with ghp_abcdefghijklmnopqrstuvwxyz0123456789", "push with [redacted]"],
    ["github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "[redacted]"],
    ["key sk-ant-api03-abcdefghijklmnopqrstuv", "key [redacted]"],
    ["key sk-proj-abcdefghijklmnopqrstuv", "key [redacted]"],
    ["slack xoxb-1234567890-abcdefghijkl", "slack [redacted]"],
    ["aws AKIAABCDEFGHIJKLMNOP", "aws [redacted]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXNpZw", "jwt [redacted]"],
    ["Authorization: Bearer abc.def.ghi-123", "Authorization: [redacted]"],
    ["proxy-authorization=Basic dXNlcjpwYXNz", "proxy-authorization=[redacted]"],
    ["sent Bearer abcdefgh12345678", "sent Bearer [redacted]"],
    ["Authorization: Bearer    opaque-credential-value", "Authorization: [redacted]"],
    ["authorization:\tBasic\t\tdXNlcjpwYXNz rest", "authorization:\t[redacted] rest"],
    ['{"Proxy-Authorization": "Bearer   opaque-credential-value"}', '{"Proxy-Authorization": "[redacted]"}'],
    ["Proxy-Authorization:  Bearer \t opaque-credential-value", "Proxy-Authorization:  [redacted]"],
    ["Authorization: Bearer\nnext line stays", "Authorization: [redacted]\nnext line stays"],
    ["sent Bearer\t\topaque-credential", "sent Bearer\t\t[redacted]"],
    ["clone https://x-access-token:abc123@github.com/acme/web.git", "clone https://[redacted]@github.com/acme/web.git"],
    ['{"api_key": "abc123", "password":"hunter2"}', '{"api_key": "[redacted]", "password":"[redacted]"}'],
    ['{"password":"correct horse, battery; staple","next":1}', '{"password":"[redacted]","next":1}'],
    ['{"client_secret": "a\\"b c"} done', '{"client_secret": "[redacted]"} done'],
    ["DB_PASSWORD='two words' ok", "DB_PASSWORD='[redacted]' ok"],
    ["STRIPE_SECRET_KEY=rk_live_x DB_PASSWD=pw", "STRIPE_SECRET_KEY=[redacted] DB_PASSWD=[redacted]"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----\nnext", "[redacted]\nnext"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow cut off", "[redacted]"],
  ];
  for (const [text, expected] of cases) assert.equal(redact(text, []), expected, text);
});

test("a controller log's ordinary lines pass unchanged", () => {
  const log = [
    "2026-10-27T03:12:09.114Z services: web ready on 5173",
    "Error: Guest command got no answer within 13000 ms",
    "    at Timeout._onTimeout (/opt/nexus/src/pylon-vm/runtime.ts:412:17)",
    "dotfiles: pulled main at 1a2b3c4d",
    "git: HEAD is 0123456789abcdef0123456789abcdef01234567, tree 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "sk-short and ghp_short and token counts: 1200",
  ].join("\n");
  assert.equal(redact(log, []), log);
});
