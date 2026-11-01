/** The cleanup pass: one question per node about what it could delete, and the deletes the person agrees to. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupPass } from "./cleanup.ts";
import { cleanupQuestion } from "./cleanup-model.ts";
import { addThread, observeNode, seedRegistry, testNode, testRegistry } from "./test-kit.ts";
import { testImage } from "../test-kit.ts";
import type { ReleaseInventory } from "../deploy/release-cleanup.ts";
import type { DeleteOutcome } from "../protocol/cleanup.ts";
import type { ImageId, PortableArtifactId, ProjectId, TailnetNodeId, TemplateId } from "../ids.ts";
import type { TemplateRecord } from "./templates.ts";
import type { Registry } from "./registry.ts";

const hour = 3_600_000;
const now = 1_800_000_000_000;
const [older, previous, current] = ["img-000000000001", "img-000000000002", "img-000000000003"] as ImageId[] as [ImageId, ImageId, ImageId];
const template = (id: string, builtAt: number): TemplateRecord =>
  ({ id: id as TemplateId, key: { project: "acme" as ProjectId, image: current, setupHash: id }, state: "ready", builtOn: testNode, builtAt, commit: "c" });
const oldTemplate = template("tpl-00000000000a", now - 200 * hour);
const newest = template("tpl-00000000000b", now - 100 * hour);
const [r1, r2, r3] = ["1", "2", "3"].map((n) => n.repeat(40)) as [string, string, string];
const inventory = (running: Record<string, number> = {}, names = [r1, r2, r3]): ReleaseInventory => ({
  releases: names.map((name, i) => ({ name, commit: name, bytes: 1000 * (i + 1), installedAt: i })),
  links: { current: r3, "control-current": r3, "deployer-current": r3 },
  replaced: { probe: r2, control: r2 },
  running,
});

function setUp(t: import("node:test").TestContext) {
  const registry = seedRegistry(testRegistry(t));
  for (const id of [older, previous, current]) { registry.saveImage(testImage({ id }), null); registry.setCurrentImage(id); }
  for (const t of [oldTemplate, newest]) registry.saveTemplate(t);
  let held: PortableArtifactId[] = [];
  const observe = (artifacts: PortableArtifactId[]) => { held = artifacts; observeNode(registry, { artifacts }); };
  observe([older, previous, current, oldTemplate.id, newest.id]);
  const dropped: PortableArtifactId[][] = [];
  const refuse = new Map<PortableArtifactId, string>();
  let dropping = () => {};
  const probe = {
    artifactUsage: async () => ({ artifacts: [older, previous, current, oldTemplate.id, newest.id].map((id, i) => ({ id, bytes: (i + 1) * 1024 ** 3 })) }),
    dropArtifacts: async (ids: readonly PortableArtifactId[]) => {
      dropped.push([...ids]);
      dropping();
      const outcome = (id: PortableArtifactId): DeleteOutcome =>
        !held.includes(id) ? { state: "gone" } : refuse.has(id) ? { state: "skipped", reason: refuse.get(id)! } : { state: "deleted", bytes: 4 * 1024 ** 3 };
      return { outcomes: Object.fromEntries(ids.map((id) => [id, outcome(id)])) };
    },
  };
  const logs: string[] = [];
  let clock = now;
  const pass = cleanupPass({ registry, probes: new Map([[testNode, probe]]), log: (m) => logs.push(m), now: () => clock++ });
  return { registry, pass, dropped, refuse, observe, onDrop: (next: () => void) => { dropping = next; } };
}

const asked = (registry: Registry) => registry.nodeQuestions(testNode);
const keysOf = (registry: Registry) => asked(registry).map((q) => q.cleanup.items.map((i) => i.kind === "release" ? i.name.slice(0, 1) : i.id));
const answer = (registry: Registry, option: "Delete" | "Keep") => registry.answerQuestion(asked(registry).at(-1)!.id, { option, by: "nLAPTOP" as TailnetNodeId, at: now });

test("one question per node, asked again only once a new candidate joins, with each item's space and the total", async (t) => {
  const { registry, pass, observe } = setUp(t);
  pass.releases(testNode, inventory());
  await pass.poll();
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[oldTemplate.id, older, "1"]], "the previous image and release and the newest template stay, and a second pass asks nothing");
  const [q] = asked(registry);
  assert.deepEqual(q!.cleanup.items.map((i) => i.bytes), [4 * 1024 ** 3, 1024 ** 3, 1000]);
  assert.match(q!.text, /holds 3 things nothing needs any more, which take 5\.0 GiB\. Delete them\?/);
  assert.deepEqual(registry.openNodeQuestions().map((o) => o.id), [q!.id]);

  observe([older, previous, current, newest.id]);
  await pass.poll();
  assert.equal(asked(registry).length, 1, "a smaller set asks nothing");

  pass.releases(testNode, inventory({}, [r1, "4".repeat(40), r2, r3]));
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[older, "1", "4"]], "a new release joined, so a new question replaces the open one");
  assert.deepEqual(registry.openNodeQuestions().length, 1);
});

test("a rejected set is not asked again until something new joins it, and nothing is deleted", async (t) => {
  const { registry, pass, dropped } = setUp(t);
  pass.releases(testNode, inventory());
  await pass.poll();
  answer(registry, "Keep");
  await pass.poll();
  await pass.poll();
  assert.deepEqual(dropped, [], "the probe deletes nothing");
  assert.deepEqual(pass.releases(testNode, inventory()), [], "the deployer deletes nothing");
  assert.equal(asked(registry).length, 1, "the same set is not asked again");
  assert.deepEqual(asked(registry)[0]!.cleanup.outcomes, {});
  assert.deepEqual(registry.openNodeQuestions(), []);

  registry.saveImage(testImage({ id: "img-000000000004" }), null);
  registry.setCurrentImage("img-000000000004");
  await pass.poll();
  assert.deepEqual(keysOf(registry).at(-1), [oldTemplate.id, older, previous, "1"], "the image current was made previous, and previous joined, so the person is asked again");
});

test("accept deletes each item once, and one that came into use after the question is skipped with why", async (t) => {
  const { registry, pass, dropped } = setUp(t);
  pass.releases(testNode, inventory({}, ["0".repeat(40), r1, r2, r3]));
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[oldTemplate.id, older, "0", "1"]]);
  const started = addThread(registry, { firstBoot: { kind: "template", template: oldTemplate.id } });
  answer(registry, "Delete");
  await pass.poll();
  await pass.poll();
  assert.deepEqual(dropped, [[older]], "the probe is sent only what nothing uses now, and only once");
  assert.deepEqual(pass.releases(testNode, inventory({ [r1]: 99 }, ["0".repeat(40), r1, r2, r3])), ["0".repeat(40)], "the deployer is asked to delete only the release nothing keeps now");
  pass.releases(testNode, inventory({ [r1]: 99 }, [r1, r2, r3]), { ["0".repeat(40)]: { state: "deleted", bytes: 1000 } });
  assert.deepEqual(pass.releases(testNode, inventory({}, [r1, r2, r3])), [], "every item is settled, so a later report asks for nothing");
  const [q] = asked(registry);
  assert.deepEqual(q!.cleanup.outcomes, {
    [oldTemplate.id]: { state: "skipped", reason: `pylon ${started.pylonId} boots from it` },
    [older]: { state: "deleted", bytes: 4 * 1024 ** 3 },
    [`release-${"0".repeat(40)}`]: { state: "deleted", bytes: 1000 },
    [`release-${r1}`]: { state: "skipped", reason: "process 99 runs from it, as a pylon's controller does from the release it started from" },
  });
  await pass.poll();
  assert.equal(asked(registry).length, 1, "what was skipped is not asked about again until something new joins");
});

test("an item the node no longer holds is gone, and one the probe refuses is skipped with the probe's reason", async (t) => {
  const { registry, pass, dropped, refuse, observe } = setUp(t);
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[oldTemplate.id, older]]);
  answer(registry, "Delete");
  observe([older, previous, current, newest.id]);
  refuse.set(older, `${older} is still needed by pylon pylon-th-2`);
  await pass.poll();
  assert.deepEqual(dropped, [[oldTemplate.id, older]], "the probe hears of the one gone too, and removes what a delete cut short left of it");
  assert.deepEqual(asked(registry)[0]!.cleanup.outcomes, {
    [oldTemplate.id]: { state: "gone" },
    [older]: { state: "skipped", reason: `${older} is still needed by pylon pylon-th-2` },
  });
});

test("a cleanup of more artifacts than one request may name goes to the probe in batches, each checked again before it goes", async (t) => {
  const { registry, pass, dropped, observe, onDrop } = setUp(t);
  const many = Array.from({ length: 1001 }, (_, i) => `tpl-${i.toString(36).padStart(6, "0")}` as TemplateId);
  observe([current, ...many]);
  const q = registry.askQuestion(cleanupQuestion(testNode, many.map((id) => ({ kind: "template", id, project: null, bytes: 1 })), now));
  answer(registry, "Delete");
  let started: ReturnType<typeof addThread> | undefined;
  onDrop(() => { started ??= addThread(registry, { firstBoot: { kind: "template", template: many.at(-1)! } }); });
  await pass.poll();
  assert.deepEqual(dropped.map((batch) => batch.length), [1000], "the last one, which a start took up while the first batch ran, is not sent");
  const { outcomes } = registry.nodeQuestions(testNode).find((n) => n.id === q.id)!.cleanup;
  assert.equal(Object.keys(outcomes).length, 1001);
  assert.deepEqual(outcomes[many.at(-1)!], { state: "skipped", reason: `pylon ${started!.pylonId} boots from it` });
});

test("an approved artifact the node no longer lists is not sent while a rule keeps it, as after it became the previous image", async (t) => {
  const { registry, pass, dropped, observe } = setUp(t);
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[oldTemplate.id, older]]);
  answer(registry, "Delete");
  observe([previous, current, newest.id]);
  registry.saveImage(testImage({ id: "img-000000000004" }), null);
  registry.setCurrentImage(older);
  await pass.poll();
  assert.deepEqual(dropped, [[oldTemplate.id]]);
  assert.deepEqual(asked(registry)[0]!.cleanup.outcomes[older], { state: "skipped", reason: "it is the current image" });
});

test("a kept set that recurs after another question is not asked again, the open question stays, and a new item asks under a new ID", async (t) => {
  const { registry, pass, observe } = setUp(t);
  observe([older, previous, current, newest.id]);
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[older]]);
  answer(registry, "Keep");
  const thread = addThread(registry, { boot: { image: older } });
  observe([older, previous, current, newest.id, oldTemplate.id]);
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[older], [oldTemplate.id]], "the older image is in use, and the old template joined");
  registry.setThreadStatus(thread.id, "deleted");
  addThread(registry, { firstBoot: { kind: "template", template: oldTemplate.id } });
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[older], [oldTemplate.id]], "the image was kept, so nothing is asked and the open question stays");
  pass.releases(testNode, inventory());
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[older], [older, "1"]], "a new release joins, so the image is asked about with it, and the open question gives way");
  const [kept, again] = asked(registry);
  assert.notEqual(again!.id, kept!.id);
  assert.equal(kept!.answer!.option, "Keep", "the answered one keeps its answer");
  assert.deepEqual(registry.openNodeQuestions().map((q) => q.id), [again!.id]);
});

test("items the person kept are not asked again after a question about others came between, while the node was offline", async (t) => {
  const { registry, pass, observe } = setUp(t);
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[oldTemplate.id, older]]);
  answer(registry, "Keep");
  registry.apply({ record: "node", node: testNode, state: "offline", capacity: null });
  pass.releases(testNode, inventory());
  await pass.poll();
  assert.equal(asked(registry).length, 1, "an offline node's images and templates are unknown, so nothing is asked");
  observe([older, previous, current, oldTemplate.id, newest.id]);
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[oldTemplate.id, older], [oldTemplate.id, older, "1"]], "the release joined, so the person is asked once");
  answer(registry, "Keep");
  pass.releases(testNode, inventory({}, ["0".repeat(40), r1, r2, r3]));
  await pass.poll();
  answer(registry, "Keep");
  await pass.poll();
  await pass.poll();
  assert.equal(asked(registry).length, 3, "nothing kept is asked again on later passes");
});

test("once an item is deleted, a set equal to an older question's asks nothing on any later pass", async (t) => {
  const { registry, pass, observe } = setUp(t);
  observe([older, previous, current, newest.id]);
  await pass.poll();
  answer(registry, "Keep");
  pass.releases(testNode, inventory());
  await pass.poll();
  assert.deepEqual(keysOf(registry), [[older], [older, "1"]]);
  answer(registry, "Delete");
  await pass.poll();
  pass.releases(testNode, inventory({}, [r2, r3]), { [r1]: { state: "deleted", bytes: 1000 } });
  for (let i = 0; i < 3; i++) await pass.poll();
  assert.equal(asked(registry).length, 2, "the candidates are the first question's set again, which asks nothing");
  assert.deepEqual(registry.openNodeQuestions(), []);
});
