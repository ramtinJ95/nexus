/**
 * docs/multiplayer-plan.md's mp-11 on the boot path: what a person adds for their own pylons reaches those pylons only,
 * fixed when each starts. A pylon's network is read as its VM backend reads its boot, through networkOptions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { image, node, sharedProject, testApi } from "../test-support/api-kit.ts";
import { tailnet, type WhoisAnswer } from "../test-support/people.ts";
import { parseWhois } from "../node-base/tailscaled.ts";
import { networkOptions } from "../pylon-vm/network.ts";
import type { BootSpec } from "../pylon-vm/contracts.ts";
import type { ImageId, Person, ProjectId, PylonId, ThreadId } from "../ids.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import { peopleOf } from "./people.ts";
import { effectiveAllowedHosts } from "./project.ts";
import { setupHashOf } from "./templates.ts";

const alice = tailnet.alice.UserProfile!.LoginName as Person;
const bob = tailnet.bob.UserProfile!.LoginName as Person;
const people = peopleOf({ [alice]: "admin", [bob]: "engineer" });
const mcpHost = "mcp.alice.example";
const aliceMcp = "alice-mcp-made-up-0000";

/** A shared install whose people the kit signed in to Claude and GitHub, with sharedProject, which grants STRIPE_KEY to api.stripe.com. */
async function shared(t: Parameters<typeof testApi>[0]) {
  let caller: WhoisAnswer = tailnet.alice;
  const s = await testApi(t, { people, allowed: new Set(), whois: async () => ({ id: caller.Node.StableID, ...parseWhois(caller).identity }) });
  assert.equal((await s.call("POST", "/v1/projects", sharedProject)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.images.setCurrentImage(image.id as ImageId);
  const start = async (who: WhoisAnswer) => {
    caller = who;
    const started = await s.call("POST", "/v1/threads", { project: "acme", title: `${who.UserProfile!.DisplayName}'s work` });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    return { id: started.body.id as string, pylonId: started.body.pylonId as PylonId };
  };
  return { ...s, start, as(who: WhoisAnswer) { caller = who; } };
}

/** The pylon's network as its VM backend builds it, each owner grant's value the one the node's probe was handed for it. */
function vm(s: Awaited<ReturnType<typeof shared>>, pylonId: PylonId) {
  const { boot } = s.registry.threads.pylon(pylonId)!;
  const handed = new Map(s.pylonSecrets.filter(([pylon]) => pylon === pylonId).map(([, name, value]) => [name, value]));
  const spec: BootSpec = {
    resources: { cpus: 2, memoryGiB: 4 }, allowedHosts: [...boot.network.allowedHosts],
    secrets: Object.fromEntries(boot.network.secrets.map((grant) => [grant.name, { hosts: [...grant.hosts], value: handed.get(grant.name) ?? "the-node-file-value" }])),
    ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null,
  };
  const { httpHooks, placeholders } = networkOptions(spec, pylonId);
  return {
    boot, placeholders,
    reaches: (hostname: string) => httpHooks!.isIpAllowed!({ hostname, ip: "203.0.113.5", family: 4, port: 443, protocol: "https" }),
    /** The authorization `url` gets when the guest sends the placeholder of `name`. */
    async sends(url: string, name: string) {
      const out = await httpHooks!.onRequest!(new Request(url, { headers: { authorization: `Bearer ${placeholders[name]}` } }));
      return (out as Request).headers.get("authorization");
    },
  };
}

test("alice's own hosts and secret reach her pylon only, with her value swapped in at her host", async (t) => {
  const s = await shared(t);
  await s.call("PUT", `/v1/own/hosts/${mcpHost}`);
  await s.call("PUT", "/v1/own/hosts/docs.alice.example");
  await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceMcp, hosts: [mcpHost] });
  const pylons = { alice: (await s.start(tailnet.alice)).pylonId, bob: (await s.start(tailnet.bob)).pylonId };
  const [a, b] = [vm(s, pylons.alice), vm(s, pylons.bob)];

  assert.equal(await a.reaches(mcpHost), true, "alice's pylon reaches her host");
  assert.equal(await b.reaches(mcpHost), false, "bob's pylon is refused it");
  assert.equal(await a.reaches("docs.alice.example"), true, "a host alice added without a secret reaches her pylon too");
  assert.equal(await b.reaches("docs.alice.example"), false);
  assert.equal(await a.sends(`https://${mcpHost}/mcp`, "MCP_TOKEN"), `Bearer ${aliceMcp}`, "her placeholder is swapped for her value at her host");
  await assert.rejects(async () => a.sends("https://docs.alice.example/", "MCP_TOKEN"), /secret MCP_TOKEN not allowed for host: docs\.alice\.example/, "and only at the hosts she gave it");
  assert.equal(b.placeholders["MCP_TOKEN"], undefined, "bob's pylon has no MCP_TOKEN");
  assert.deepEqual(s.pylonSecrets.filter(([, name]) => name === "MCP_TOKEN").map(([pylon, , value]) => [pylon, value]), [[pylons.alice, aliceMcp]], "the probe got MCP_TOKEN for alice's pylon only");
  assert.deepEqual(a.boot.network.secrets.find((grant) => grant.name === "MCP_TOKEN"), { name: "MCP_TOKEN", hosts: [mcpHost], owner: true }, "her grant never falls back to the node's secret file");
});

test("alice's own secret of a project grant's name takes its place in her pylon only", async (t) => {
  const s = await shared(t);
  await s.call("PUT", "/v1/own/secrets/STRIPE_KEY", { value: "alice-stripe-made-up", hosts: ["payments.alice.example"] });
  const pylons = { alice: (await s.start(tailnet.alice)).pylonId, bob: (await s.start(tailnet.bob)).pylonId };
  const [a, b] = [vm(s, pylons.alice), vm(s, pylons.bob)];
  assert.deepEqual(a.boot.network.secrets.filter((grant) => grant.name === "STRIPE_KEY"), [{ name: "STRIPE_KEY", hosts: ["payments.alice.example"], owner: true }]);
  assert.equal(await a.sends("https://payments.alice.example/charge", "STRIPE_KEY"), "Bearer alice-stripe-made-up");
  await assert.rejects(async () => a.sends("https://api.stripe.com/v1/charges", "STRIPE_KEY"), /secret STRIPE_KEY not allowed for host: api\.stripe\.com/, "her value never goes to the project's host");
  assert.deepEqual(b.boot.network.secrets.filter((grant) => grant.name === "STRIPE_KEY"), sharedProject.secrets, "bob's pylon keeps the project's grant");
  assert.equal(await b.sends("https://api.stripe.com/v1/charges", "STRIPE_KEY"), "Bearer the-node-file-value");
});

test("a pylon keeps its start's own hosts and secrets for life, and a later handoff gives the value its owner has now", async (t) => {
  const s = await shared(t);
  await s.call("PUT", `/v1/own/hosts/${mcpHost}`);
  await s.call("PUT", "/v1/own/hosts/docs.alice.example");
  await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceMcp, hosts: [mcpHost] });
  const { id, pylonId } = await s.start(tailnet.alice);
  const booted = s.registry.threads.pylon(pylonId)!.boot;
  const outdated = async () => (await s.call("GET", `/v1/threads/${id}`)).body.pylon.grantsOutdated;
  assert.equal(await outdated(), false, "a fresh pylon with its owner's own hosts and secrets is current");

  await s.call("DELETE", "/v1/own/hosts/docs.alice.example");
  await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: "alice-mcp-rotated", hosts: [mcpHost, "mcp2.alice.example"] });
  await s.call("PUT", "/v1/own/secrets/LATER_TOKEN", { value: "alice-later-made-up", hosts: ["later.alice.example"] });
  assert.deepEqual(s.registry.threads.pylon(pylonId)!.boot, booted, "her edits after the start leave its boot as it was");
  assert.equal(await outdated(), false, "and do not show it outdated");

  const handed = async (probeBootId: string) => {
    s.pylonSecrets.length = 0;
    s.owners!.observed(node, { probeBootId, pylons: [{ pylonId, phase: "running", bootedAt: "2027-01-01T00:00:00Z" } as NodeObservation["pylons"][number]] });
    await s.owners!.close();
    return s.pylonSecrets.map(([, name, value]) => `${name} ${value}`).sort();
  };
  assert.deepEqual(await handed("restarted"), ["CLAUDE_CODE_OAUTH_TOKEN sk-ant-oat01-alice@example.com-made-up", "GH_TOKEN ghp_alice@example.comMadeUp", "MCP_TOKEN alice-mcp-rotated"],
    "a probe that restarted is handed the boot's own grants with their values now, and not a secret added since");
  await s.call("DELETE", "/v1/own/secrets/MCP_TOKEN");
  assert.deepEqual(await handed("restarted-again"), ["CLAUDE_CODE_OAUTH_TOKEN sk-ant-oat01-alice@example.com-made-up", "GH_TOKEN ghp_alice@example.comMadeUp"]);
  assert.match(s.logged.join("\n"), new RegExp(`${pylonId} on rj-firebat has no secret MCP_TOKEN of alice@example\\.com's, which they removed`));
  assert.ok(s.logged.every((line) => !line.includes("alice-mcp") && !line.includes("alice-later")), "no log line holds a value");

  s.as(tailnet.alice);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { allowedHosts: [...sharedProject.allowedHosts, "another.example.com"] })).status, 200);
  assert.equal(await outdated(), true, "a host the project added since still shows it outdated");
});

test("a template's build and setup hash carry no person's own host, so every engineer's start shares it", async (t) => {
  const s = await shared(t);
  await s.call("PUT", `/v1/own/hosts/${mcpHost}`);
  await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceMcp, hosts: [mcpHost] });
  const inputs = { commit: "a".repeat(40), setupBlob: "b".repeat(40) };
  s.remoteReads(async () => inputs);
  const started = await s.start(tailnet.alice);
  const [template] = s.registry.images.templates("acme" as ProjectId);
  assert.ok(template !== undefined && template.state === "building", "alice's start asked for a template build");
  const project = s.registry.projects.project("acme" as ProjectId)!;
  assert.deepEqual(template.inputs.allowedHosts, effectiveAllowedHosts(project), "the build reaches the project's hosts");
  assert.ok(!template.inputs.allowedHosts.includes(mcpHost), "and not alice's");
  assert.equal(template.key.setupHash, setupHashOf(project, inputs));
  assert.ok(s.registry.threads.pylon(started.pylonId)!.boot.network.allowedHosts.includes(mcpHost), "while her own pylon reaches her host");
  const bobs = await s.start(tailnet.bob);
  const setup = s.registry.threads.thread(bobs.id as ThreadId)!.setup;
  assert.equal(setup !== undefined && "building" in setup ? setup.building : undefined, template.id, "bob's start waits on the same template");
});

test("a check the control plane starts for alice boots with her own hosts and secrets", async (t) => {
  const s = await shared(t);
  await s.call("PUT", `/v1/own/hosts/${mcpHost}`);
  await s.call("PUT", "/v1/own/secrets/MCP_TOKEN", { value: aliceMcp, hosts: [mcpHost] });
  const check = await s.startThread({ request: { project: "acme", title: "Check" }, caller: "control-plane", owner: alice, role: "check" });
  assert.equal(await vm(s, check.pylonId).reaches(mcpHost), true);
  assert.deepEqual(s.pylonSecrets.filter(([pylon, name]) => pylon === check.pylonId && name === "MCP_TOKEN").map(([, , value]) => value), [aliceMcp]);
});
