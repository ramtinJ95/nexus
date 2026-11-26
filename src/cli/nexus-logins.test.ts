import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { main } from "./main.ts";
import { setup } from "../test-support/cli-kit.ts";

const token = "sk-ant-oat01-made-up-0000";

test("login reads a token from stdin and logins says which are set, never what they are", async (t) => {
  const s = await setup(t);
  const stored = await s.nexus(["login", "claude"], undefined, `${token}\n`);
  assert.equal(stored.code, 0, stored.stderr);
  assert.equal(stored.stdout, "Stored your Claude token.\nLogins of operator:\nLogin   State\nclaude  set\ngithub  not set\n");
  const listed = await s.nexus(["logins", "--json"]);
  assert.deepEqual(JSON.parse(listed.stdout), { person: "operator", set: { claude: true, github: false } });
  const removed = await s.nexus(["logout", "claude"]);
  assert.match(removed.stdout, /^Removed your Claude token, if one was set\.\n.*\nclaude  not set\n/s);
  for (const run of [stored, listed, removed]) assert.ok(!`${run.stdout}${run.stderr}`.includes(token));
});

test("login refuses a terminal's stdin, an empty one, and a kind it does not know, before it calls the API", async (t) => {
  const s = await setup(t);
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let shown = "";
  stderr.on("data", (chunk: Buffer) => { shown += chunk.toString(); });
  assert.equal(await main(["login", "github"], { stdin, stdout: new PassThrough(), stderr, env: s.env() }), 64);
  assert.match(shown, /reads the token from stdin, so a terminal never shows it\. Pipe it in, such as: pbpaste \| nexus login github/);
  assert.match((await s.nexus(["login", "github"], undefined, "\n")).stderr, /read no token from stdin/);
  assert.match((await s.nexus(["login", "codex"], undefined, token)).stderr, /no login codex: the logins are claude, github/);
  assert.deepEqual(JSON.parse((await s.nexus(["logins", "--json"])).stdout).set, { claude: false, github: false });
});
