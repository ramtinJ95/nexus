/** Project routes: add, edit, grants and the identity a pylon boots with. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Thread } from "./thread-store.ts";
import { githubTokenGrant } from "../secret-grants.ts";
import type { ImageId, ProjectId } from "../ids.ts";
import type { TailnetNodeId } from "../ids.ts";
import { project, image, testApi, withThread } from "./api-test-kit.ts";

test("projects are created, listed, and checked", async (t) => {
  const s = await testApi(t);
  assert.deepEqual(await s.call("POST", "/v1/projects", project), { status: 201, body: project });
  assert.deepEqual(await s.call("GET", "/v1/projects"), { status: 200, body: [project] });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 409);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", defaultNode: "nowhere" })).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", resources: { cpus: 0, memoryGiB: 4, diskGiB: 10 } })).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", extra: true })).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", repoUrl: "https://" })).status, 400, "a pylon's allowlist needs the host of an HTTPS repo");
});

test("a scratch project has no repository, and each of its threads starts an empty one on its branch", async (t) => {
  const s = await testApi(t);
  const scratch = { ...project, id: "sketch", repoUrl: null, allowedHosts: [], logins: [], secrets: [githubTokenGrant] };
  assert.deepEqual(await s.call("POST", "/v1/projects", scratch), { status: 201, body: scratch });
  assert.deepEqual((await s.call("GET", "/v1/projects")).body, [scratch]);
  assert.equal((await s.call("POST", "/v1/projects", { ...scratch, id: "empty-url", repoUrl: "" })).status, 400, "only null makes a scratch project");
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);

  const started = await s.call("POST", "/v1/threads", { project: "sketch", title: "Sketch" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual(started.body.setup, { how: "fresh", reason: "the project is scratch, so it has no template" });
  assert.deepEqual(s.reads, [], "a scratch project has no remote to read");
  const pylon = s.registry.pylon(started.body.pylonId)!;
  assert.deepEqual(pylon.boot.repo, { kind: "empty", branch: "main" });
  assert.deepEqual(pylon.boot.network, { allowedHosts: ["api.github.com", "github.com"], secrets: [githubTokenGrant] }, "the grant opens GitHub, and no repo host joins");
  assert.match(pylon.live.overlay[2]!.content, /new repository on branch main with no commits and no remote/);

  const trunk = await s.call("POST", "/v1/threads", { project: "sketch", title: "Trunk", branch: "trunk" });
  assert.deepEqual(s.registry.pylon(trunk.body.pylonId)!.boot.repo, { kind: "empty", branch: "trunk" });

  const pinned = await s.call("POST", "/v1/threads", { project: "sketch", title: "Pinned", commit: "abc123" });
  assert.equal(pinned.status, 400);
  assert.match(pinned.body.error, /sketch is a scratch project, so it has no commit to check out/);
  assert.equal(s.registry.threads("sketch" as Thread["project"]).length, 2, "no thread was created");
  assert.equal(s.calls.length, 2, "no conversation was started");
});

test("a pylon's allowlist reaches its project's HTTPS repo host and the HTTPS dotfiles host", async (t) => {
  const s = await withThread(t, {
    project: { ...project, repoUrl: "https://github.com/octocat/Spoon-Knife.git", allowedHosts: [], secrets: [], logins: [] },
    dotfiles: { repo: "https://gitlab.example.com/ramtin/dotfiles.git", ref: "main" },
  });
  assert.deepEqual(s.registry.pylon(s.thread.pylonId)!.boot.network.allowedHosts, ["github.com", "gitlab.example.com"]);
});

test("project edits validate before saving, flag older grants, and leave checkpoint boots unchanged", async (t) => {
  const s = await withThread(t);
  const before = s.registry.pylon(s.thread.pylonId)!.boot;
  const secrets = [...project.secrets, { name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }];
  const edited = await s.call("PATCH", "/v1/projects/acme", { secrets, logins: ["claude"] });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.secrets, secrets);
  assert.equal((await s.call("GET", `/v1/threads/${s.thread.id}`)).body.pylon.grantsOutdated, true);
  await s.call("POST", `/v1/threads/${s.thread.id}/archive`);
  await s.call("POST", `/v1/threads/${s.thread.id}/unarchive`);
  assert.deepEqual(s.registry.pylon(s.thread.pylonId)!.boot, before);
  const next = await s.call("POST", "/v1/threads", { project: "acme", title: "New grants" });
  assert.deepEqual(s.registry.pylon(next.body.pylonId)!.boot.network.secrets, secrets);
  for (const patch of [{ id: "other" }, { repoUrl: "https://example.com/new" }, { defaultNode: "missing" }, { resources: { cpus: 0, memoryGiB: 4, diskGiB: 10 } }, { secrets: [{ name: "TOKEN", hosts: [] }] }, { secrets: [{ name: "TOKEN", hosts: ["*.example.com"] }] }]) {
    assert.equal((await s.call("PATCH", "/v1/projects/acme", patch)).status, 400);
    assert.deepEqual(s.registry.project(project.id as ProjectId), edited.body);
  }
  assert.equal((await s.call("PATCH", "/v1/projects/missing", {})).status, 404);
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { secrets: [] })).status, 403);
});

test("a thread started with HTTPS dotfiles shows its grants current until its project's hosts change", async (t) => {
  const s = await withThread(t, { dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" } });
  assert.ok(s.registry.pylon(s.thread.pylonId)!.boot.network.allowedHosts.includes("github.com"), "the dotfiles host is in the boot's allowlist");
  const outdated = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body.pylon.grantsOutdated;
  assert.equal(await outdated(), false);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { allowedHosts: [...project.allowedHosts, "another.example.com"] })).status, 200);
  assert.equal(await outdated(), true);
});

test("pylon boot inherits the person's identity and a project can override or clear it", async (t) => {
  const gitIdentity = { name: "Example Person", email: "person@example.com" };
  const s = await withThread(t, { gitIdentity });
  assert.deepEqual(s.registry.pylon(s.thread.pylonId)!.boot.gitIdentity, gitIdentity);
  const override = { name: "Work Person", email: "work@example.com" };
  for (const identity of [override, null]) {
    assert.equal((await s.call("PATCH", "/v1/projects/acme", { gitIdentity: identity })).status, 200);
    const next = await s.call("POST", "/v1/threads", { project: "acme", title: "Identity" });
    const pylon = s.registry.pylon(next.body.pylonId)!;
    assert.deepEqual(pylon.boot.gitIdentity, identity ?? gitIdentity);
    assert.ok(pylon.live.overlay[2]!.content.includes((identity ?? gitIdentity).email));
  }
});

test("partial resource patches merge atomically without resetting another edit", async (t) => {
  const s = await withThread(t);
  const edits = await Promise.all([
    s.call("PATCH", "/v1/projects/acme", { resources: { cpus: 4 } }),
    s.call("PATCH", "/v1/projects/acme", { resources: { memoryGiB: 8 } }),
  ]);
  for (const result of edits) assert.equal(result.status, 200);
  assert.deepEqual(s.registry.project(project.id as ProjectId)!.resources, { ...project.resources, cpus: 4, memoryGiB: 8 });
  const before = s.registry.project(project.id as ProjectId);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { resources: { cpus: 16 }, defaultNode: "missing" })).status, 400);
  assert.deepEqual(s.registry.project(project.id as ProjectId), before, "a refused edit rolls back every field");
});

test("grant comparison ignores order and duplicates but detects changed access", async (t) => {
  const original = {
    ...project,
    allowedHosts: ["registry.npmjs.org", "example.com"],
    logins: ["claude", "chatgpt"],
    secrets: [
      { name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] },
      { name: "STRIPE_KEY", hosts: ["api.stripe.com", "files.stripe.com"] },
    ],
  };
  const s = await withThread(t, { project: original });
  const outdated = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body.pylon.grantsOutdated;
  assert.equal(await outdated(), false);
  const pylon = s.registry.pylon(s.thread.pylonId)!;
  s.registry.savePylon({ ...pylon, boot: { ...pylon.boot, network: { ...pylon.boot.network, allowedHosts: [...pylon.boot.network.allowedHosts].reverse() } } });
  const reordered = {
    allowedHosts: [...original.allowedHosts].reverse(),
    logins: [...original.logins].reverse(),
    secrets: [...original.secrets].reverse().map((grant) => ({ ...grant, hosts: [...grant.hosts].reverse() })),
  };
  assert.equal((await s.call("PATCH", "/v1/projects/acme", reordered)).status, 200);
  assert.equal(await outdated(), false);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", {
    allowedHosts: [...reordered.allowedHosts, ...reordered.allowedHosts],
    logins: [...reordered.logins, ...reordered.logins],
    secrets: reordered.secrets.map((grant) => ({ ...grant, hosts: [...grant.hosts, ...grant.hosts] })),
  })).status, 200);
  assert.equal(await outdated(), false);
  for (const changed of [
    { secrets: [original.secrets[0]] },
    { secrets: [{ ...original.secrets[0], hosts: ["github.com"] }, original.secrets[1]] },
    { allowedHosts: ["another.example.com"] },
    { logins: ["claude"] },
  ]) {
    assert.equal((await s.call("PATCH", "/v1/projects/acme", { ...reordered, ...changed })).status, 200);
    assert.equal(await outdated(), true);
  }
});

test("project add and edit refuse a grant of the ChatGPT token, which comes with the chatgpt login", async (t) => {
  const s = await withThread(t);
  const before = s.registry.project(project.id as ProjectId);
  const secrets = [{ name: "NEXUS_CHATGPT_TOKEN", hosts: ["api.openai.com"] }];
  const added = await s.call("POST", "/v1/projects", { ...project, id: "granted", secrets });
  assert.equal(added.status, 400);
  assert.match(added.body.error, /NEXUS_CHATGPT_TOKEN comes with the chatgpt login: add the login instead/);
  assert.equal(s.registry.project("granted" as ProjectId), undefined);
  const edited = await s.call("PATCH", "/v1/projects/acme", { secrets });
  assert.equal(edited.status, 400);
  assert.deepEqual(s.registry.project(project.id as ProjectId), before);
});

test("project add and edit refuse duplicate secret names instead of merging their grants", async (t) => {
  const s = await withThread(t);
  const before = s.registry.project(project.id as ProjectId);
  for (const hosts of [["b.example"], ["a.example"]]) {
    const secrets = [{ name: "TOKEN", hosts: ["a.example"] }, { name: "TOKEN", hosts }];
    const added = await s.call("POST", "/v1/projects", { ...project, id: "duplicate", secrets });
    assert.equal(added.status, 400);
    assert.match(added.body.error, /duplicate secret names: list all of a secret's hosts in one grant/);
    assert.equal(s.registry.project("duplicate" as ProjectId), undefined);
    const edited = await s.call("PATCH", "/v1/projects/acme", { secrets, resources: { cpus: 16 } });
    assert.equal(edited.status, 400);
    assert.match(edited.body.error, /duplicate secret names: list all of a secret's hosts in one grant/);
    assert.deepEqual(s.registry.project(project.id as ProjectId), before);
  }
  const secrets = [{ name: "TOKEN", hosts: ["a.example", "b.example"] }];
  const added = await s.call("POST", "/v1/projects", { ...project, id: "combined", secrets });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.secrets, secrets);
  const edited = await s.call("PATCH", "/v1/projects/acme", { secrets });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.secrets, secrets);
});
