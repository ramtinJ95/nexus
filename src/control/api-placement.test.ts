/** Where a thread start boots its pylon, from which template, and at what size. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { Thread } from "./registry.ts";
import type { ProjectId } from "../ids.ts";
import type { TemplateRecord } from "./templates.ts";
import { stoppedPylon } from "../test-kit.ts";
import type { NodeName } from "../ids.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import { node, project, image, observeNode, withImage } from "./api-test-kit.ts";

test("--node auto boots the pylon on the node with the most memory left after it, and the thread records why", async (t) => {
  const s = await withImage(t);
  observeNode(s, "big", { total: 64, committed: 48 });
  observeNode(s, "small", { total: 32, committed: 24 });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const thread = started.body as Thread;
  assert.deepEqual(thread.placement, {
    how: "auto", node: "big", weighed: [
      { node: "big", left: { cpus: 10, memoryGiB: 12, diskGiB: 190 } },
      { node: "rj-firebat", refused: "is offline" },
      { node: "small", left: { cpus: 10, memoryGiB: 4, diskGiB: 190 } },
    ],
  });
  assert.equal(s.registry.pylon(thread.pylonId)!.node, "big");
  assert.deepEqual(s.woken, ["big"]);
  assert.deepEqual((await s.call("GET", `/v1/threads/${thread.id}`)).body.thread.placement, thread.placement, "show reads it back");

  const next = await s.call("POST", "/v1/threads", { project: "acme", title: "Next", node: "auto" });
  assert.equal(next.body.placement.node, "big", "big still has 8 GiB left once its unreported pylon is counted, and small 4");
  const third = await s.call("POST", "/v1/threads", { project: "acme", title: "Third", node: "auto" });
  assert.equal(third.body.placement.node, "small", "two unreported pylons leave big as little memory as small, and fewer CPUs");
});

test("--node auto counts the memory of a paused pylon about to wake, and not of one that stays paused", async (t) => {
  const s = await withImage(t);
  observeNode(s, "a", { total: 64, committed: 0 });
  observeNode(s, "b", { total: 64, committed: 2 });
  const waking = (await s.call("POST", "/v1/threads", { project: "acme", title: "Waking", node: "a" })).body as Thread;
  observeNode(s, "a", { total: 64, committed: 0 }, { pylons: [stoppedPylon(waking.pylonId, { sessions: null })] });
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" })).body.placement.node, "b");
  assert.equal((await s.call("POST", `/v1/threads/${waking.id}/archive`)).status, 200);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Placed again", node: "auto" })).body.placement.node, "a",
    "once Waking stays paused, a has 60 GiB left, and b 54 with Placed still to boot there");
});

test("--node auto counts the memory of an archived thread's paused pylon the usage backfill wakes to read", async (t) => {
  const s = await withImage(t);
  observeNode(s, "a", { total: 64, committed: 0 });
  observeNode(s, "b", { total: 64, committed: 6 });
  const archived = (await s.call("POST", "/v1/threads", { project: "acme", title: "Archived", node: "a" })).body as Thread;
  observeNode(s, "a", { total: 64, committed: 0 }, { pylons: [stoppedPylon(archived.pylonId, { sessions: null })] });
  assert.equal((await s.call("POST", `/v1/threads/${archived.id}/archive`)).status, 200);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" })).body.placement.node, "a");
  s.registry.startUsageBackfill([archived.id], Date.now());
  s.registry.holdUsageBackfill(archived.id, Date.now());
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Placed again", node: "auto" })).body.placement.node, "b",
    "a has 52 GiB left once Placed and the woken Archived boot, and b 54");
});

test("--node auto passes over a node whose stored observation is from a probe older than grants", async (t) => {
  const s = await withImage(t);
  observeNode(s, "old", { total: 64, committed: 0 }, { grants: undefined as never });
  observeNode(s, "new", { total: 16, committed: 8 });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.placement.node, "new");
  assert.deepEqual(started.body.placement.weighed.find((w: { node: string }) => w.node === "old"), { node: "old", refused: "runs a probe too old to report what its pylons hold" });
});

test("--node auto counts a crashed pylon a person retried, which boots again, and not one whose VM still holds its memory", async (t) => {
  const s = await withImage(t);
  observeNode(s, "b", { total: 16, committed: 10 });
  observeNode(s, "a", { total: 16, committed: 0 });
  const t1 = (await s.call("POST", "/v1/threads", { project: "acme", title: "Crashed", node: "a" })).body as Thread;
  s.registry.savePylon({ ...s.registry.pylon(t1.pylonId)!, boot: { ...s.registry.pylon(t1.pylonId)!.boot, resources: { cpus: 2, memoryGiB: 12, diskGiB: 10 } }, retrying: true });
  const broken = (cause: "controller" | "services") => ({ pylonId: t1.pylonId, phase: "broken" as const, detail: "the controller exited", cause, logTail: "" });
  observeNode(s, "a", { total: 16, committed: 0 }, { pylons: [broken("controller")] });
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "x", node: "auto" })).body.placement.node, "b",
    "a will boot the retried 12 GiB pylon again, which leaves it 0 GiB, and b 2");
  observeNode(s, "a", { total: 16, committed: 12 }, { pylons: [broken("services")] });
  const weighed = (await s.call("POST", "/v1/threads", { project: "acme", title: "y", node: "auto" })).body.placement.weighed;
  assert.deepEqual(weighed.find((w: { node: string }) => w.node === "a").left.memoryGiB, 0, "a broken VM that is still up is counted once, in the node's capacity");
});

test("--node auto refuses with each node's reason when none can run the pylon, and starts nothing", async (t) => {
  const s = await withImage(t);
  observeNode(s, "full", { total: 32, committed: 30 });
  observeNode(s, "no-image", { total: 64, committed: 0 }, { artifacts: [] });
  observeNode(s, "no-secret", { total: 64, committed: 0 }, { grants: { secrets: [], gitSsh: true } });
  observeNode(s, "no-token", { total: 64, committed: 0 }, { grants: { secrets: ["STRIPE_KEY"], gitSsh: true } });
  observeNode(s, "token-coming", { total: 16, committed: 0 }, { grants: { secrets: [], gitSsh: true }, heldSecrets: ["NEXUS_CHATGPT_TOKEN"] });
  observeNode(s, "no-ssh", { total: 64, committed: 0 }, { grants: { secrets: ["STRIPE_KEY", "NEXUS_CHATGPT_TOKEN"], gitSsh: false } });
  observeNode(s, "old-probe", { total: 64, committed: 0 }, { grants: null as never });
  const refused = await s.call("POST", "/v1/threads", { project: "acme", title: "Nowhere", node: "auto" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "no node can run this pylon: full has 30 of 32 GiB of memory committed, and the pylon needs 4; "
    + `no-image does not hold image ${image.id}; no-secret has no secret STRIPE_KEY in its secret file, NEXUS_CHATGPT_TOKEN, which its probe is too old to take from the control plane; `
    + "no-ssh has no git SSH key to reach git@example.com:acme.git and git@github.com:ramtin/dotfiles.git; no-token has no secret NEXUS_CHATGPT_TOKEN, which its probe is too old to take from the control plane; "
    + "old-probe runs a probe too old to report what its pylons hold; rj-firebat is offline; token-coming has no secret STRIPE_KEY in its secret file");
  assert.deepEqual((await s.call("GET", "/v1/threads")).body, []);
  assert.deepEqual(s.calls, [], "no conversation was started for it");
  assert.deepEqual(s.woken, []);
});

test("a pylon that asks for nested virtualization goes only to a node whose probe reports it", async (t) => {
  const s = await withImage(t);
  observeNode(s, "flat", { total: 64, committed: 0 });
  observeNode(s, "nests", { total: 16, committed: 0 }, { nestedVirtualization: true });
  const nested = await s.startThread({ project: "acme", title: "Verify", node: "auto", bare: true, resources: { memoryGiB: 8, nestedVirtualization: true } }, "nexus-verify");
  const placement = nested.placement?.how === "auto" ? nested.placement : assert.fail("placed auto");
  assert.equal(placement.node, "nests");
  assert.deepEqual(placement.weighed.find((w) => w.node === "flat"), { node: "flat", refused: "cannot give a pylon KVM of its own: its probe does not report nested virtualization" });
  assert.deepEqual(s.registry.pylon(nested.pylonId)!.boot.resources, { cpus: 2, memoryGiB: 8, diskGiB: 10, nestedVirtualization: true });
  const plain = (await s.call("POST", "/v1/threads", { project: "acme", title: "Plain", node: "auto" })).body;
  assert.equal(plain.placement.node, "flat", "an ordinary pylon still goes where it fits best");
  assert.deepEqual(s.registry.pylon(plain.pylonId)!.boot.resources, { cpus: 2, memoryGiB: 4, diskGiB: 10 });
});

test("--node auto places a thread that needs the ChatGPT token on a node whose probe takes it and has not got it yet", async (t) => {
  const s = await withImage(t);
  const restarted = { secrets: ["STRIPE_KEY"], gitSsh: true };
  observeNode(s, "big", { total: 64, committed: 0 }, { grants: restarted, heldSecrets: ["NEXUS_CHATGPT_TOKEN"] });
  observeNode(s, "small", { total: 32, committed: 0 }, { grants: restarted, heldSecrets: ["NEXUS_CHATGPT_TOKEN"] });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Right after a restart", node: "auto" });
  assert.equal(started.status, 201, started.body.error);
  assert.equal(started.body.placement.node, "big");
  assert.deepEqual(s.woken, ["big"]);
});

test("without --node a thread still boots on its project's default node, and a named node is taken as named", async (t) => {
  const s = await withImage(t);
  observeNode(s, "big", { total: 64, committed: 0 });
  const plain = await s.call("POST", "/v1/threads", { project: "acme", title: "Default" });
  assert.deepEqual(plain.body.placement, { how: "default", node }, "even while the default node is offline and another has room");
  assert.equal(s.registry.pylon(plain.body.pylonId)!.node, node);
  const named = await s.call("POST", "/v1/threads", { project: "acme", title: "Named", node: "big" });
  assert.deepEqual(named.body.placement, { how: "named", node: "big" });
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "x", node: "nowhere" })).status, 400);
});

test("a start near a node boots there while it has room, on the roomiest node once it has none, and there all the same when no node has room", async (t) => {
  const s = await withImage(t);
  observeNode(s, "big", { total: 64, committed: 0 });
  observeNode(s, "full", { total: 32, committed: 40 });
  const beside = await s.startThread({ project: "acme", title: "Beside", near: "big" as NodeName }, "nexus-review");
  assert.deepEqual(beside.placement, { how: "named", node: "big" });
  const spilled = await s.startThread({ project: "acme", title: "Spilled", near: "full" as NodeName }, "nexus-review");
  assert.deepEqual(spilled.placement, {
    how: "auto", node: "big", weighed: [
      { node: "big", left: { cpus: 8, memoryGiB: 56, diskGiB: 180 } },
      { node: "full", refused: "is overcommitted, with 40 of 32 GiB of memory committed" },
      { node: "rj-firebat", refused: "is offline" },
    ],
  });
  observeNode(s, "big", { total: 64, committed: 70 });
  const stayed = await s.startThread({ project: "acme", title: "Stayed", near: "full" as NodeName }, "nexus-review");
  assert.deepEqual(stayed.placement, { how: "named", node: "full" }, "no node has room, so it stays where it was asked to be near");
});

test("the first start of a setup builds its template on the node, the next waits for it, and one after it is ready boots from it at the commit read", async (t) => {
  const s = await withImage(t);
  observeNode(s, node, { total: 64, committed: 0 });
  const [first, moved] = ["1".repeat(40), "2".repeat(40)];
  s.remoteReads(async () => ({ commit: first, setupBlob: "b".repeat(40) }));

  const building = (await s.call("POST", "/v1/threads", { project: "acme", title: "First", branch: "feature" })).body as Thread;
  const [template] = s.registry.templates(project.id as ProjectId);
  assert.ok(template?.state === "building");
  assert.deepEqual(building.setup, { how: "fresh", reason: `no template of this setup is on ${node} yet`, building: template.id });
  assert.deepEqual([template.on, template.inputs.repo, template.submitted], [node, { url: project.repoUrl, branch: "feature", commit: first }, null], "the build checks out the commit the setup was read at");
  assert.deepEqual(s.registry.pylon(building.pylonId)!.firstBoot, { kind: "fresh", preSetup: null });
  assert.deepEqual(s.registry.pylon(building.pylonId)!.boot.repo, { kind: "clone", url: project.repoUrl, checkout: { branch: "feature", commit: "origin/feature" } });

  const waiting = (await s.call("POST", "/v1/threads", { project: "acme", title: "Second", branch: "feature" })).body as Thread;
  assert.deepEqual(waiting.setup, { how: "fresh", reason: `template ${template.id} of this setup is still building on ${node}`, building: template.id });
  assert.equal(s.registry.templates(project.id as ProjectId).length, 1, "a running build is not started twice");

  const builtAt = Date.now() - 60_000;
  s.registry.saveTemplate({ id: template.id, key: template.key, state: "ready", builtOn: node, builtAt, commit: first });
  observeNode(s, node, { total: 64, committed: 0 }, { artifacts: [image.id, template.id] as NodeObservation["artifacts"] });
  s.remoteReads(async () => ({ commit: moved, setupBlob: "b".repeat(40) }));
  const reused = (await s.call("POST", "/v1/threads", { project: "acme", title: "Third", branch: "feature" })).body as Thread;
  assert.deepEqual(reused.setup, { how: "template", template: template.id, builtAt, commit: moved });
  const pylon = s.registry.pylon(reused.pylonId)!;
  assert.deepEqual(pylon.firstBoot, { kind: "template", template: template.id });
  assert.deepEqual(pylon.boot.repo, { kind: "clone", url: project.repoUrl, checkout: { branch: "feature", commit: moved } }, "the pylon checks out the commit its setup was read at, not the branch's tip at boot");
  assert.deepEqual((await s.call("GET", `/v1/threads/${reused.id}`)).body.thread.setup, reused.setup, "show reads it back");
  assert.deepEqual(s.reads, [{ branch: "feature" }, { branch: "feature" }, { branch: "feature" }]);
});

test("a start whose setup cannot be read boots fresh and says why, and only a full commit ID is read", async (t) => {
  const s = await withImage(t);
  const unread = (await s.call("POST", "/v1/threads", { project: "acme", title: "Unread" })).body as Thread;
  assert.deepEqual(unread.setup, { how: "fresh", reason: "the control plane could not read .nexus/setup at main: this test has no remote" });
  assert.deepEqual(s.registry.templates(project.id as ProjectId), []);
  assert.deepEqual(s.registry.pylon(unread.pylonId)!.firstBoot, { kind: "fresh", preSetup: null });

  const short = (await s.call("POST", "/v1/threads", { project: "acme", title: "Short", commit: "abc123" })).body as Thread;
  assert.deepEqual(short.setup, { how: "fresh", reason: "the start named commit abc123, and only a full commit ID or a branch tip can use a template" });
  assert.deepEqual(s.registry.pylon(short.pylonId)!.boot.repo, { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "abc123" } });

  const full = "f".repeat(40);
  s.remoteReads(async () => ({ commit: full, setupBlob: null }));
  const pinned = (await s.call("POST", "/v1/threads", { project: "acme", title: "Pinned", commit: full })).body as Thread;
  assert.deepEqual(s.reads, [{ branch: "main" }, { commit: full }]);
  assert.deepEqual(s.registry.templates(project.id as ProjectId).map((r: TemplateRecord) => r.state === "building" && r.inputs.repo), [{ url: project.repoUrl, branch: "main", commit: full }]);
  assert.equal(pinned.setup?.how, "fresh");
});

test("two overlapping --node auto starts take different rooms, and a start that fails gives its room back", async (t) => {
  const s = await withImage(t);
  observeNode(s, "a", { total: 16, committed: 8 });
  observeNode(s, "b", { total: 16, committed: 9 });
  const { harness } = s.fake;
  const start = harness.startThread;
  const held = Promise.withResolvers<void>();
  let entered = 0;
  harness.startThread = async (thread) => { entered++; await held.promise; return start(thread); };
  const both = [s.call("POST", "/v1/threads", { project: "acme", title: "One", node: "auto" }), s.call("POST", "/v1/threads", { project: "acme", title: "Two", node: "auto" })];
  while (entered < 2) await sleep(5);
  held.resolve();
  const placed = (await Promise.all(both)).map((r) => r.body.placement.node);
  assert.deepEqual(placed.toSorted(), ["a", "b"], "the second start sees the room the first one reserved on a");

  observeNode(s, "a", { total: 16, committed: 0 });
  observeNode(s, "b", { total: 16, committed: 0 });
  harness.startThread = async () => { throw new Error("the harness is down"); };
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Fails", node: "a" })).status, 500);
  harness.startThread = start;
  const after = await s.call("POST", "/v1/threads", { project: "acme", title: "After", node: "auto" });
  assert.deepEqual(after.body.placement.weighed.filter((w: { node: string }) => w.node !== "rj-firebat"), [
    { node: "a", left: { cpus: 8, memoryGiB: 8, diskGiB: 180 } },
    { node: "b", left: { cpus: 8, memoryGiB: 8, diskGiB: 180 } },
  ], "each node counts the one overlapping start it has yet to report, and a counts nothing of the start that failed");
});

test("a project whose default node is auto places each thread that names none, and a named node still pins", async (t) => {
  const s = await withImage(t);
  observeNode(s, "big", { total: 64, committed: 0 });
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { defaultNode: "nowhere" })).status, 400);
  const edited = await s.call("PATCH", "/v1/projects/acme", { defaultNode: "auto" });
  assert.deepEqual([edited.status, edited.body.defaultNode], [200, "auto"]);
  const plain = await s.call("POST", "/v1/threads", { project: "acme", title: "Plain" });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual([plain.body.placement.how, plain.body.placement.node], ["auto", "big"]);
  const named = await s.call("POST", "/v1/threads", { project: "acme", title: "Named", node });
  assert.deepEqual(named.body.placement, { how: "named", node });
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "spread", defaultNode: "auto" })).status, 201);
});

test("--node auto refuses an overcommitted node with its reason, and places the pylon on one that fits", async (t) => {
  const s = await withImage(t);
  observeNode(s, "firebat", { total: 22.8, committed: 40 });
  observeNode(s, "testbench", { total: 32, committed: 0 });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" });
  assert.equal(started.body.placement.node, "testbench");
  assert.deepEqual(started.body.placement.weighed.find((w: { node: string }) => w.node === "firebat"), { node: "firebat", refused: "is overcommitted, with 40 of 22.8 GiB of memory committed" });
});

test("a start whose disk differs from its project's boots fresh without a template, and one that changes only CPUs or memory may use one", async (t) => {
  const s = await withImage(t);
  s.remoteReads(async () => ({ commit: "1".repeat(40), setupBlob: "b".repeat(40) }));
  const disk = (await s.call("POST", "/v1/threads", { project: "acme", title: "Disk", resources: { diskGiB: 40 } })).body as Thread;
  assert.deepEqual(disk.setup, { how: "fresh", reason: "the start asked for a 40 GiB disk, and this project's templates have 10 GiB" });
  assert.deepEqual([s.reads, s.registry.templates(project.id as ProjectId)], [[], []], "nothing is read, and no template of the project's size is built for it");
  const memory = (await s.call("POST", "/v1/threads", { project: "acme", title: "Memory", resources: { memoryGiB: 12 } })).body as Thread;
  assert.equal(memory.setup?.how, "fresh");
  assert.ok(memory.setup?.how === "fresh" && memory.setup.building !== undefined, "it asks for the project's template, whose disk it can boot");
  assert.deepEqual(s.reads, [{ branch: "main" }]);
});

test("a template built before the project's disk size changed is not reused by a start of the new size", async (t) => {
  const s = await withImage(t);
  observeNode(s, node, { total: 64, committed: 0 });
  s.remoteReads(async () => ({ commit: "1".repeat(40), setupBlob: "b".repeat(40) }));
  await s.call("POST", "/v1/threads", { project: "acme", title: "Builds" });
  const [old] = s.registry.templates(project.id as ProjectId);
  assert.ok(old?.state === "building");
  s.registry.saveTemplate({ id: old.id, key: old.key, state: "ready", builtOn: node, builtAt: Date.now() - 60_000, commit: "1".repeat(40) });
  observeNode(s, node, { total: 64, committed: 0 }, { artifacts: [image.id, old.id] as NodeObservation["artifacts"] });
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Reuses" })).body.setup.how, "template", "the 10 GiB template serves a 10 GiB start");

  assert.equal((await s.call("PATCH", "/v1/projects/acme", { resources: { diskGiB: 40 } })).status, 200);
  const sized = (await s.call("POST", "/v1/threads", { project: "acme", title: "Sized", resources: { diskGiB: 40 } })).body as Thread;
  assert.equal(sized.setup?.how, "fresh", "the 10 GiB template's disk cannot be a 40 GiB pylon's");
  assert.ok(sized.setup?.how === "fresh" && sized.setup.building !== undefined && sized.setup.building !== old.id, "a 40 GiB template is built for the next thread");
  assert.deepEqual(s.registry.pylon(sized.pylonId)!.firstBoot, { kind: "fresh", preSetup: null });
});

test("a start's size overrides its project's field by field, its pylon boots that size, and thread detail reads it back", async (t) => {
  const s = await withImage(t);
  const bigger = await s.call("POST", "/v1/threads", { project: "acme", title: "Bigger", resources: { memoryGiB: 12 } });
  assert.equal(bigger.status, 201, JSON.stringify(bigger.body));
  assert.deepEqual(s.registry.pylon(bigger.body.pylonId)!.boot.resources, { cpus: 2, memoryGiB: 12, diskGiB: 10 }, "the fields it leaves out are the project's");
  assert.deepEqual((await s.call("GET", `/v1/threads/${bigger.body.id}`)).body.pylon.resources, { cpus: 2, memoryGiB: 12, diskGiB: 10 });
  const sized = await s.call("POST", "/v1/threads", { project: "acme", title: "Sized", resources: { cpus: 4, memoryGiB: 8, diskGiB: 40 } });
  assert.deepEqual(s.registry.pylon(sized.body.pylonId)!.boot.resources, { cpus: 4, memoryGiB: 8, diskGiB: 40 });
  const plain = await s.call("POST", "/v1/threads", { project: "acme", title: "Plain" });
  assert.deepEqual((await s.call("GET", `/v1/threads/${plain.body.id}`)).body.pylon.resources, project.resources);

  for (const resources of [{ cpus: 0 }, { memoryGiB: -8 }, { diskGiB: 1.5 }, { memoryGiB: "8" }, { gpus: 1 }, 8]) {
    assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Wrong", resources })).status, 400, JSON.stringify(resources));
  }
  assert.deepEqual((await s.call("GET", "/v1/threads")).body.map((r: Thread) => r.title).toSorted(), ["Bigger", "Plain", "Sized"], "no refused start made a thread");
});

test("--node auto weighs a thread's own size, not its project's, and counts it once placed", async (t) => {
  const s = await withImage(t);
  observeNode(s, "small", { total: 16, committed: 8 });
  observeNode(s, "big", { total: 64, committed: 48 });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Big", node: "auto", resources: { memoryGiB: 12 } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.placement.node, "big");
  assert.deepEqual(started.body.placement.weighed.find((w: { node: string }) => w.node === "small"), { node: "small", refused: "has 8 of 16 GiB of memory committed, and the pylon needs 12" },
    "small has room for the project's 4 GiB but not the start's 12");
  const refused = await s.call("POST", "/v1/threads", { project: "acme", title: "Huge", node: "auto", resources: { memoryGiB: 20 } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /big has 60 of 64 GiB of memory committed, and the pylon needs 20/, "big counts Big's 12 GiB, which it has yet to report");

});

test("an overlapping start's reservation holds the start's own size", async (t) => {
  const s = await withImage(t);
  observeNode(s, "a", { total: 16, committed: 0 });
  observeNode(s, "b", { total: 16, committed: 2 });
  const { harness } = s.fake;
  const start = harness.startThread;
  const held = Promise.withResolvers<void>();
  let entered = 0;
  harness.startThread = async (thread) => { entered++; await held.promise; return start(thread); };
  const first = s.call("POST", "/v1/threads", { project: "acme", title: "One", node: "auto", resources: { memoryGiB: 12 } });
  while (entered < 1) await sleep(5);
  const second = s.call("POST", "/v1/threads", { project: "acme", title: "Two", node: "auto" });
  while (entered < 2) await sleep(5);
  held.resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.body.placement.node, "a");
  assert.equal(two.body.placement.node, "b");
  assert.deepEqual(two.body.placement.weighed.find((w: { node: string }) => w.node === "a").left.memoryGiB, 0, "a counts the 12 GiB One reserved there, then Two's 4");
});
