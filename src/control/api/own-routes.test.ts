import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dir, phone, testApi } from "../../test-support/api-kit.ts";
import { tailnet, type WhoisAnswer } from "../../test-support/people.ts";
import { parseWhois, type TailnetCaller } from "../../node-base/tailscaled.ts";
import { peopleOf } from "../people.ts";
import { loginStore, ownCaps } from "../logins.ts";
import { chatgptTokenGrant, ownerOnlyNames } from "../../protocol/secret-grants.ts";
import type { Person, TailnetNodeId } from "../../ids.ts";

const alice = tailnet.alice.UserProfile!.LoginName as Person;
const bob = tailnet.bob.UserProfile!.LoginName as Person;
const people = peopleOf({ [alice]: "admin", [bob]: "engineer" });
const answer = (a: WhoisAnswer): TailnetCaller => ({ id: a.Node.StableID, ...parseWhois(a).identity });
/** The control plane's own node, as whois would name it were it owned by alice. */
const controlAsAlice = answer({ ...tailnet.alice, Node: { ...tailnet.alice.Node, StableID: "nFIREBAT" as TailnetNodeId } });

const aliceValue = "alice-mcp-made-up-0000";
const bobValue = "bob-mcp-made-up-0000";
const mcp = { name: "MCP_TOKEN", hosts: ["mcp.alice.example"] };
const nothing = (person: Person) => ({ person, hosts: [], secrets: [] });

/** A shared install whose every answer is kept, so a test can show none holds a value. */
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
  const noValueIn = (...values: string[]) => {
    for (const body of bodies) assert.ok(values.every((value) => !body.includes(value)), `${body.slice(0, 200)} holds no value`);
  };
  return { ...s, store, call, noValueIn, as(a: WhoisAnswer | TailnetCaller) { caller = "Node" in a ? answer(a) : a; } };
}

test("a person adds hosts and secrets for their own pylons only, and no route reaches another person's", async (t) => {
  const s = await shared(t);
  await s.call("PUT", "/v1/own/hosts/mcp.alice.example");
  const set = await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: ["mcp.alice.example"] });
  assert.deepEqual(set.body, { person: alice, hosts: ["mcp.alice.example"], secrets: [mcp] });

  s.as(tailnet.bob);
  assert.deepEqual((await s.call("GET", "/v1/own")).body, nothing(bob), "bob sees none of alice's as his");
  assert.deepEqual((await s.call("DELETE", "/v1/own/secrets/MCP_TOKEN")).body, nothing(bob), "bob's remove of alice's secret's name reaches only his own");
  assert.deepEqual((await s.call("DELETE", "/v1/own/hosts/mcp.alice.example")).body, nothing(bob));
  assert.deepEqual((await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: bobValue, hosts: ["mcp.bob.example"] })).body,
    { person: bob, hosts: [], secrets: [{ name: "MCP_TOKEN", hosts: ["mcp.bob.example"] }] }, "bob's set of the same name makes his own");

  s.as(tailnet.alice);
  assert.deepEqual((await s.call("GET", "/v1/own")).body, { person: alice, hosts: ["mcp.alice.example"], secrets: [mcp] }, "alice's host and secret outlived bob's removes");
  assert.equal((await s.logins.owned(alice)).secrets[0]!.value, aliceValue, "and her value outlived bob's set of the name");
  assert.deepEqual((await s.call("PUT", "/v1/own/hosts/mcp.alice.example")).body.hosts, ["mcp.alice.example"], "adding a host twice keeps one");
  assert.deepEqual((await s.call("DELETE", "/v1/own/hosts/absent.example.com")).body.hosts, ["mcp.alice.example"], "removing an absent host changes nothing");
  assert.deepEqual((await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: ["b.alice.example", "a.alice.example", "b.alice.example"] })).body.secrets,
    [{ name: "MCP_TOKEN", hosts: ["a.alice.example", "b.alice.example"] }], "a set takes the place of the name's secret, its hosts deduped and sorted");
  s.noValueIn(aliceValue, bobValue);
});

test("each person's hosts and secrets are in their own file, mode 0600, which goes once they remove everything", async (t) => {
  const s = await shared(t);
  await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: ` ${aliceValue}\n`, hosts: ["mcp.alice.example"] });
  assert.deepEqual(await readdir(s.store), ["alice%40example.com.json"]);
  assert.equal((await stat(join(s.store, "alice%40example.com.json"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(s.store, "alice%40example.com.json"), "utf8")).secrets, { MCP_TOKEN: { hosts: ["mcp.alice.example"], value: aliceValue } }, "a pasted value is stored trimmed");
  await s.call("PUT", "/v1/own/hosts/mcp.alice.example");
  assert.equal((await stat(join(s.store, "alice%40example.com.json"))).mode & 0o777, 0o600, "and stays 0600 after another write");
  await s.call("DELETE", "/v1/own/secrets/MCP_TOKEN");
  await s.call("DELETE", "/v1/own/hosts/mcp.alice.example");
  assert.deepEqual(await readdir(s.store), []);
});

const routes: readonly (readonly [string, string, unknown?])[] = [
  ["GET", "/v1/own"], ["PUT", "/v1/own/hosts/mcp.alice.example"], ["DELETE", "/v1/own/hosts/mcp.alice.example"],
  ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: ["mcp.alice.example"] }], ["DELETE", "/v1/own/secrets/MCP_TOKEN"], ["GET", "/v1/people"],
];

test("no node, pylon or the control plane reaches a person's hosts and secrets or the list of people", async (t) => {
  const s = await shared(t);
  await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: ["mcp.alice.example"] });
  // A pylon calls as the node it runs on, so the node's refusal is the pylon's.
  for (const device of [answer(tailnet.node), controlAsAlice]) {
    s.as(device);
    for (const [method, path, body] of routes) assert.equal((await s.call(method, path, body)).status, 403, `${device.id} ${method} ${path}`);
  }
  s.as(tailnet.alice);
  assert.deepEqual((await s.call("GET", "/v1/own")).body, { person: alice, hosts: [], secrets: [mcp] }, "no device changed alice's");
  s.noValueIn(aliceValue);
});

test("an admin lists each person's role, hosts and secret names, and an engineer may not", async (t) => {
  const s = await shared(t);
  await s.call("PUT", "/v1/own/hosts/mcp.alice.example");
  await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: ["mcp.alice.example"] });
  s.as(tailnet.bob);
  await s.call("PUT", "/v1/own/secrets/BOB_TOKEN", { value: bobValue, hosts: ["api.bob.example"] });
  const refused = await s.call("GET", "/v1/people");
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /only an admin may/);
  s.as(tailnet.alice);
  assert.deepEqual((await s.call("GET", "/v1/people")).body, { people: [
    { person: alice, role: "admin", hosts: ["mcp.alice.example"], secrets: [mcp] },
    { person: bob, role: "engineer", hosts: [], secrets: [{ name: "BOB_TOKEN", hosts: ["api.bob.example"] }] },
  ] });
  s.noValueIn(aliceValue, bobValue);
});

test("a reserved name, a bad name, value or host, and a secret for GitHub are refused without repeating what was sent", async (t) => {
  const s = await shared(t);
  const put = (name: string, body: unknown) => s.call("PUT", `/v1/own/secrets/${encodeURIComponent(name)}`, body);
  for (const name of [...ownerOnlyNames, chatgptTokenGrant.name]) {
    const r = await put(name, { value: aliceValue, hosts: ["mcp.alice.example"] });
    assert.equal(r.status, 400, name);
    assert.match(r.body.error, new RegExp(`^${name} is a secret no person adds: `));
  }
  for (const host of ["github.com", "api.github.com"]) {
    const r = await put("MCP_TOKEN", { value: aliceValue, hosts: ["mcp.alice.example", host] });
    assert.equal(r.status, 400, host);
    assert.match(r.body.error, /never goes to .*github\.com: your pylons' one GitHub credential is your own nexus login github/);
  }
  const refusals: [string, string, unknown][] = [
    ["PUT", "/v1/own/secrets/MCP_TOKEN=pasted0value", { value: aliceValue, hosts: ["mcp.alice.example"] }],
    ["PUT", "/v1/own/secrets/mcp_token", { value: aliceValue, hosts: ["mcp.alice.example"] }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: "has a space pasted0value", hosts: ["mcp.alice.example"] }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: "pasted0value".padEnd(16_385, "x"), hosts: ["mcp.alice.example"] }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: "", hosts: ["mcp.alice.example"] }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: [] }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: Array.from({ length: 17 }, (_, i) => `h${i}.alice.example`) }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: ["pasted0value"] }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: ["*.alice.example"] }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: "mcp.alice.example" }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceValue, hosts: ["mcp.alice.example"], extra: "pasted0value" }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { "pasted0value-as-a-key": true }],
    ["PUT", "/v1/own/secrets/MCP_TOKEN", { value: 42, hosts: ["mcp.alice.example"] }],
    ["PUT", "/v1/own/hosts/pasted0value", undefined],
    ["PUT", "/v1/own/hosts/*.alice.example", undefined],
    ["PUT", "/v1/own/hosts/MCP.ALICE.EXAMPLE", undefined],
    ["PUT", `/v1/own/hosts/${"a".repeat(250)}.example`, undefined],
  ];
  for (const [method, path, body] of refusals) assert.equal((await s.call(method, path, body)).status, 400, `${path.slice(0, 60)} ${JSON.stringify(body)?.slice(0, 60)}`);
  s.noValueIn(aliceValue, "pasted0value", "has a space", "xxxx");
  assert.deepEqual((await s.call("GET", "/v1/own")).body, nothing(alice), "nothing refused was stored");
});

test("a person's caps refuse one host or secret too many, and still let them replace a secret they have", async (t) => {
  const s = await shared(t);
  for (let i = 0; i < ownCaps.hosts; i++) assert.equal((await s.call("PUT", `/v1/own/hosts/h${i}.alice.example`)).status, 200);
  const host = await s.call("PUT", "/v1/own/hosts/one-more.alice.example");
  assert.equal(host.status, 409);
  assert.match(host.body.error, /at most 64 hosts.*nexus host remove/);
  assert.equal((await s.call("PUT", "/v1/own/hosts/h0.alice.example")).status, 200, "adding a host there at the cap changes nothing");
  for (let i = 0; i < ownCaps.secrets; i++) assert.equal((await s.call("PUT", `/v1/own/secrets/TOKEN_${i}`, { value: aliceValue, hosts: ["api.alice.example"] })).status, 200);
  const secret = await s.call("PUT", "/v1/own/secrets/ONE_MORE", { value: aliceValue, hosts: ["api.alice.example"] });
  assert.equal(secret.status, 409);
  assert.match(secret.body.error, /at most 32 secrets.*nexus secret remove/);
  assert.equal((await s.call("PUT", "/v1/own/secrets/TOKEN_0", { value: aliceValue, hosts: ["api2.alice.example"] })).status, 200);
  const own = (await s.call("GET", "/v1/own")).body;
  assert.equal(own.hosts.length, ownCaps.hosts);
  assert.equal(own.secrets.length, ownCaps.secrets);
  s.noValueIn(aliceValue);
});

test("a solo install refuses each of these routes, since its one person edits the project's hosts and secrets instead", async (t) => {
  const s = await testApi(t);
  s.callAs(phone);
  for (const [method, path, body] of routes) {
    const r = await s.call(method, path, body);
    assert.equal(r.status, 409, `${method} ${path}`);
    assert.equal(r.body.code, "solo-install");
    assert.match(r.body.error, /nexus project edit <id> --allow-host HOST and --secret NAME:HOST/);
    assert.ok(!JSON.stringify(r.body).includes(aliceValue));
  }
});
