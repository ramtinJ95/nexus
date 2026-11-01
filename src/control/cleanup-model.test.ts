/** What a node could delete, and what a rollback keeps. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactKept, cleanupCandidates, cleanupQuestion, grew, itemKey, type NodeFacts } from "./cleanup-model.ts";
import { garbage, type TemplateRecord } from "./templates.ts";
import type { ReleaseInventory } from "../deploy/release-cleanup.ts";
import type { ImageId, NodeName, ProjectId, PylonId, TemplateId } from "../ids.ts";

const now = 1_800_000_000_000;
const hour = 3_600_000;
const node = "rj-firebat" as NodeName;
const current: ImageId = "img-000000000003";
const previous: ImageId = "img-000000000002";
const older: ImageId = "img-000000000001";
const acme = "acme" as ProjectId;
const ready = (id: string, builtAt: number, project = acme, image = current): TemplateRecord =>
  ({ id: id as TemplateId, key: { project, image, setupHash: id }, state: "ready", builtOn: node, builtAt, commit: "c" });

const oldTemplate = ready("tpl-00000000000a", now - 200 * hour);
const agedToo = ready("tpl-00000000000b", now - 100 * hour);
const loneOfItsProject = ready("tpl-00000000000c", now - 500 * hour, "lone" as ProjectId);
const young = ready("tpl-00000000000d", now - hour);
const release = (name: string, installedAt: number) => ({ name: name.repeat(40 / name.length), commit: name.repeat(40 / name.length), bytes: 100, installedAt });
const [r1, r2, r3, r4, r5] = ["1", "2", "3", "4", "5"].map((n, i) => release(n, i * 1000)) as [ReturnType<typeof release>, ...ReturnType<typeof release>[]];
const inventory: ReleaseInventory = {
  releases: [r1, r2!, r3!, r4!, r5!],
  links: { current: r5!.name, "control-current": r5!.name, "deployer-current": r5!.name },
  replaced: { probe: null, control: null },
  running: {},
};
const facts: NodeFacts = {
  held: [current, previous, older, oldTemplate.id, agedToo.id, loneOfItsProject.id, young.id],
  templates: [oldTemplate, agedToo, loneOfItsProject, young],
  current, previous, operated: current,
  boots: [],
  releases: inventory,
};
const keys = (f: NodeFacts) => cleanupCandidates(node, f, now).map(itemKey);

test("garbage keeps the previous image, which a rollback rolls out again, as it keeps the current one", () => {
  assert.deepEqual(garbage([current, previous, older], [], { imageBuildNode: node, current }, now), [previous, older], "without the previous image named, it goes");
  assert.deepEqual(garbage([current, previous, older], [], { imageBuildNode: node, current, previous }, now), [older]);
});

test("a node's candidates: aged templates but each project's newest ready one, images but the current and previous, and releases nothing keeps", () => {
  assert.deepEqual(keys(facts), [oldTemplate.id, agedToo.id, older, `release-${r1.name}`, `release-${r2!.name}`, `release-${r3!.name}`],
    "each project's newest ready template stays, as do the current and previous image, the release every link names and the one installed before it");
  assert.equal(artifactKept(node, facts, loneOfItsProject.id, now), "it is its project's newest ready template", "though it is 500 hours old");
  assert.equal(artifactKept(node, facts, young.id, now), "it is under 72 hours old");
  assert.equal(artifactKept(node, facts, previous, now), "it is the previous image, which a rollback rolls out again");
  assert.equal(artifactKept(node, facts, current, now), "it is the current image");
  assert.equal(artifactKept(node, facts, oldTemplate.id, now), null, "a candidate is not kept");
});

test("the release before the one each link runs is kept: the one its journal says it replaced, or else the newest installed before it", () => {
  const probeMoved: ReleaseInventory = { ...inventory, links: { current: r5!.name, "control-current": r3!.name, "deployer-current": r5!.name } };
  assert.deepEqual(keys({ ...facts, releases: probeMoved }).filter((k) => k.startsWith("release-")), [`release-${r1.name}`],
    "the probe's link keeps r5 and r4 before it, the control plane's keeps r3 and r2 before it");
  const replaced: ReleaseInventory = { ...inventory, replaced: { probe: r2!.name, control: null } };
  assert.deepEqual(keys({ ...facts, releases: replaced }).filter((k) => k.startsWith("release-")), [`release-${r1.name}`, `release-${r3!.name}`],
    "the probe's last install replaced r2, so r2 stays, and the control plane, with no journal, keeps r4");
  const running: ReleaseInventory = { ...inventory, running: { [r1.name]: 4242 } };
  assert.deepEqual(keys({ ...facts, releases: running }).filter((k) => k.startsWith("release-")), [`release-${r2!.name}`, `release-${r3!.name}`], "a controller runs from r1");
  assert.deepEqual(keys({ ...facts, releases: null }).filter((k) => k.startsWith("release-")), [], "a node whose deployer reports no releases deletes none");
});

test("the image of the latest build or rollout is kept, as is one the node no longer lists but that a rule now keeps", () => {
  const rolling: NodeFacts = { ...facts, operated: older };
  assert.deepEqual(keys(rolling).filter((k) => k.startsWith("img-")), [], "a rollout copies it to the nodes before it becomes current");
  assert.equal(artifactKept(node, rolling, older, now), "the latest image build or rollout is of it");
  const unlisted: NodeFacts = { ...facts, held: facts.held!.filter((id) => id !== previous && id !== oldTemplate.id) };
  assert.equal(artifactKept(node, unlisted, previous, now), "it is the previous image, which a rollback rolls out again", "a copy may have brought it back since the observation");
  assert.equal(artifactKept(node, unlisted, oldTemplate.id, now), null, "one no rule keeps goes to the probe, which reports it gone");
});

test("an image or template a pylon on the node boots from is no candidate, and is kept with why", () => {
  const booting: NodeFacts = { ...facts, boots: [{ pylon: "pylon-th-1" as PylonId, image: older, template: oldTemplate.id }] };
  assert.deepEqual(keys(booting).filter((k) => !k.startsWith("release-")), [agedToo.id]);
  assert.equal(artifactKept(node, booting, oldTemplate.id, now), "pylon pylon-th-1 boots from it");
  assert.deepEqual(keys({ ...facts, held: null }).filter((k) => !k.startsWith("release-")), [], "an offline node's artifacts are unknown");
});

test("the person is asked again only once a candidate joins that the latest question did not hold", () => {
  const items = cleanupCandidates(node, facts, now).map((c) => ({ ...c, bytes: 1024 }));
  const latest = cleanupQuestion(node, items, now);
  assert.equal(grew(cleanupCandidates(node, facts, now), []), true, "with no question yet");
  assert.equal(grew(cleanupCandidates(node, facts, now), [latest]), false, "the same set");
  assert.equal(grew(cleanupCandidates(node, { ...facts, held: facts.held!.filter((id) => id !== older) }, now), [latest]), false, "a smaller set");
  const unused: ImageId = "img-000000000009";
  assert.equal(grew(cleanupCandidates(node, { ...facts, held: [...facts.held!, unused] }, now), [latest]), true, "an image nothing needs joined");
  assert.equal(cleanupQuestion(node, [...items].reverse(), now).id, latest.id, "one ID for one set and asking, whatever its order");
  assert.notEqual(cleanupQuestion(node, items, now + 1).id, latest.id, "the same set asked again is a new question");
  const other = cleanupQuestion(node, [{ kind: "release", name: "9".repeat(40), commit: null, bytes: 1 }], now + 2);
  assert.equal(grew(cleanupCandidates(node, facts, now), [latest, other]), false, "an item asked about before the latest question still counts as asked");
  const deleted = { ...latest, cleanup: { ...latest.cleanup, outcomes: { [older]: { state: "deleted" as const, bytes: 1 } } } };
  assert.equal(grew(cleanupCandidates(node, facts, now), [deleted, other]), false, "nor does one a delete removed, which an observation may still list");
  assert.match(latest.text, /^rj-firebat holds 6 things nothing needs any more, which take 6\.0 KiB\. Delete them\?\n\n- template tpl-00000000000a of project acme, 1\.0 KiB\n/);
});
