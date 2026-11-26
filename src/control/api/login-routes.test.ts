import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import { dir, phone, testApi } from "../../test-support/api-kit.ts";
import { tailnet, type WhoisAnswer } from "../../test-support/people.ts";
import { parseWhois, type TailnetCaller } from "../../node-base/tailscaled.ts";
import { peopleOf } from "../people.ts";
import { loginStore } from "../logins.ts";
import type { Person, TailnetNodeId } from "../../ids.ts";

const alice = tailnet.alice.UserProfile!.LoginName as Person;
const bob = tailnet.bob.UserProfile!.LoginName as Person;
const people = peopleOf({ [alice]: "admin", [bob]: "engineer" });
const answer = (a: WhoisAnswer): TailnetCaller => ({ id: a.Node.StableID, ...parseWhois(a).identity });
/** The control plane's own node, as whois would name it were it owned by alice. */
const controlAsAlice = answer({ ...tailnet.alice, Node: { ...tailnet.alice.Node, StableID: "nFIREBAT" as TailnetNodeId } });

const aliceToken = "sk-ant-oat01-alice-made-up-0000";
const bobToken = "ghp_bobMadeUp0000";
const none = { claude: false, github: false };

async function shared(t: Parameters<typeof testApi>[0]) {
  const store = join(dir, randomUUID());
  let caller = answer(tailnet.alice);
  const s = await testApi(t, { people, allowed: new Set(), whois: async () => caller, logins: loginStore(store) });
  const bodies: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await s.call(method, path, body);
    bodies.push(JSON.stringify(r.body));
    return r;
  };
  return { ...s, store, call, bodies, as(a: WhoisAnswer | TailnetCaller) { caller = "Node" in a ? answer(a) : a; } };
}

test("a person sets and removes only their own logins, and each sees only their own", async (t) => {
  const s = await shared(t);
  assert.deepEqual((await s.call("PUT", "/v1/logins/claude", { token: aliceToken })).body, { person: alice, set: { claude: true, github: false } });
  s.as(tailnet.bob);
  assert.deepEqual((await s.call("GET", "/v1/logins")).body, { person: bob, set: none }, "bob does not see alice's login as his");
  assert.deepEqual((await s.call("PUT", "/v1/logins/github", { token: bobToken })).body, { person: bob, set: { claude: false, github: true } });
  assert.deepEqual((await s.call("DELETE", "/v1/logins/claude")).body, { person: bob, set: { claude: false, github: true } }, "bob's remove reaches only his own store");
  s.as(tailnet.alice);
  assert.deepEqual((await s.call("GET", "/v1/logins")).body, { person: alice, set: { claude: true, github: false } }, "alice's Claude login outlived bob's remove");
  assert.deepEqual((await s.call("DELETE", "/v1/logins/claude")).body, { person: alice, set: none });
  assert.deepEqual((await s.call("DELETE", "/v1/logins/claude")).body, { person: alice, set: none }, "removing a login that is not set changes nothing");
  s.as(tailnet.bob);
  assert.deepEqual((await s.call("GET", "/v1/logins")).body, { person: bob, set: { claude: false, github: true } });
  for (const body of s.bodies) assert.ok(!body.includes(aliceToken) && !body.includes(bobToken), `${body} holds no token`);
});

test("each person's store is one file only its owner reads, which holds their token", async (t) => {
  const s = await shared(t);
  await s.call("PUT", "/v1/logins/claude", { token: ` ${aliceToken}\n` });
  s.as(tailnet.bob);
  await s.call("PUT", "/v1/logins/github", { token: bobToken });
  assert.deepEqual((await readdir(s.store)).sort(), ["alice%40example.com.json", "bob%40example.com.json"]);
  assert.equal((await stat(s.store)).mode & 0o777, 0o700);
  for (const file of await readdir(s.store)) assert.equal((await stat(join(s.store, file))).mode & 0o777, 0o600, `${file} is mode 0600`);
  assert.deepEqual(JSON.parse(await readFile(join(s.store, "alice%40example.com.json"), "utf8")), { claude: aliceToken }, "a pasted token is stored trimmed");
  await s.call("DELETE", "/v1/logins/github");
  assert.deepEqual(await readdir(s.store), ["alice%40example.com.json"], "a person with no login left has no file");
});

test("no node, pylon, tagged device or the control plane reaches the login routes", async (t) => {
  const s = await shared(t);
  // A pylon calls as the node it runs on, so the node's refusal is the pylon's.
  for (const device of [answer(tailnet.node), controlAsAlice]) {
    s.as(device);
    for (const [method, path, body] of [["GET", "/v1/logins"], ["PUT", "/v1/logins/claude", { token: aliceToken }], ["DELETE", "/v1/logins/claude"]] as const) {
      const r = await s.call(method, path, body);
      assert.equal(r.status, 403, `${device.id} ${method} ${path}`);
    }
  }
  s.as(tailnet.alice);
  assert.deepEqual((await s.call("GET", "/v1/logins")).body.set, none, "no device stored a login as alice");
});

test("a refused token is not stored and its refusal never repeats it", async (t) => {
  const s = await shared(t);
  const refusals: [string, string, unknown, number][] = [
    ["PUT", "/v1/logins/github", { token: "ghp-has a space and dashes" }, 400],
    ["PUT", "/v1/logins/claude", { token: "has a space" }, 400],
    ["PUT", "/v1/logins/claude", { token: "x".repeat(4097) }, 400],
    ["PUT", "/v1/logins/claude", { token: 42, extra: "a-secret-value" }, 400],
    ["PUT", "/v1/logins/claude", { "sk-ant-pasted-as-a-key": true }, 400],
    ["PUT", "/v1/logins/codex", { token: aliceToken }, 404],
  ];
  for (const [method, path, body, status] of refusals) {
    const r = await s.call(method, path, body);
    assert.equal(r.status, status, `${path} ${JSON.stringify(body).slice(0, 40)}`);
  }
  const malformed = await s.call("PUT", "/v1/logins/claude", undefined);
  assert.equal(malformed.status, 400);
  for (const body of s.bodies) assert.ok(!/has a space|xxxx|a-secret-value|alice-made-up|sk-ant/.test(body), `${body} repeats no value`);
  assert.deepEqual((await s.call("GET", "/v1/logins")).body.set, none);
});

test("a body that is not JSON is refused without quoting it", async (t) => {
  const s = await shared(t);
  const r = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: s.port, method: "PUT", path: "/v1/logins/claude", headers: { host: `127.0.0.1:${s.port}`, "content-type": "application/json" } }, (res: IncomingMessage) => {
      let text = "";
      res.on("data", (c: Buffer) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode!, text }));
    });
    req.on("error", reject);
    req.end(`{"token": ${aliceToken}}`);
  });
  assert.equal(r.status, 400);
  assert.ok(!r.text.includes("sk-ant"), r.text);
});

test("on a solo install the operator sets their own logins from any person's device", async (t) => {
  const s = await testApi(t);
  s.callAs(phone);
  assert.deepEqual((await s.call("PUT", "/v1/logins/claude", { token: aliceToken })).body, { person: "operator", set: { claude: true, github: false } });
  assert.deepEqual((await s.call("GET", "/v1/logins")).body, { person: "operator", set: { claude: true, github: false } });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("GET", "/v1/logins")).status, 403, "the control plane's own node is no person");
});
