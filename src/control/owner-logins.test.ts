import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dir, image, testApi } from "../test-support/api-kit.ts";
import { loginStore } from "./logins.ts";
import { tailnet, type WhoisAnswer } from "../test-support/people.ts";
import { parseWhois } from "../node-base/tailscaled.ts";
import { networkOptions } from "../pylon-vm/network.ts";
import type { BootSpec } from "../pylon-vm/contracts.ts";
import type { ImageId, NodeName, Person, PylonId } from "../ids.ts";
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
  const neither = await s.call("POST", "/v1/threads", { project: "mono", title: "bob's work" });
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
    pylons[who] = (await s.call("POST", "/v1/threads", { project: "mono", title: `${who}'s work` })).body.pylonId;
  }
  const owners = s.owners!;
  s.pylonSecrets.length = 0;
  owners.observed("rj-firebat" as NodeName, "boot-2");
  await owners.close();
  const handed = s.pylonSecrets.map(([pylon, name, value]) => `${pylon} ${name} ${value}`).sort();
  assert.deepEqual(handed, [
    `${pylons.alice} CLAUDE_CODE_OAUTH_TOKEN sk-ant-oat01-alice-made-up`, `${pylons.alice} GH_TOKEN ghp_aliceMadeUp`,
    `${pylons.bob} CLAUDE_CODE_OAUTH_TOKEN ${bobClaude}`, `${pylons.bob} GH_TOKEN ${bobGithub}`,
  ].sort());
  s.pylonSecrets.length = 0;
  owners.observed("rj-firebat" as NodeName, "boot-2");
  await owners.close();
  assert.deepEqual(s.pylonSecrets, [], "the same probe boot is not handed them twice");
  assert.ok(s.logged.every((line) => !line.includes(bobGithub) && !line.includes(bobClaude)), "no log line holds a token");
});

test("a solo install boots with the project's grants, the node's values and the configured git identity", async (t) => {
  const s = await testApi(t);
  assert.equal((await s.call("POST", "/v1/projects", { ...mono, gitIdentity: { name: "Project", email: "project@example.com" } })).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.images.setCurrentImage(image.id as ImageId);
  const started = await s.call("POST", "/v1/threads", { project: "mono", title: "work" });
  assert.equal(started.status, 201);
  const { boot } = s.registry.threads.pylon(started.body.pylonId)!;
  assert.deepEqual(boot.network.secrets, mono.secrets);
  assert.deepEqual(boot.gitIdentity, { name: "Project", email: "project@example.com" });
  assert.deepEqual(s.pylonSecrets, []);
});
