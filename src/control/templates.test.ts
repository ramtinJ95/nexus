import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseTemplate, garbage, setupHashOf, templateIdOf, templateMaxAgeMs, type SetupInputs, type TemplateRecord } from "./templates.ts";
import type { TemplateBuildInputs, TemplateKey } from "../images.ts";
import type { RemoteProject } from "./project.ts";
import type { ArtifactId, CheckpointId, ImageId, NodeName, ProjectId } from "../ids.ts";

const now = 1_800_000_000_000;
const hour = 3_600_000;
const node = "rj-firebat" as NodeName;
const peer = "infra-testbench" as NodeName;

const project: RemoteProject = {
  id: "acme-web" as ProjectId,
  repoUrl: "git@github.com:ramtin/acme-web.git",
  defaultBranch: "main",
  defaultNode: node,
  resources: { cpus: 4, memoryGiB: 8, diskGiB: 20 },
  allowedHosts: ["registry.npmjs.org"],
  secrets: [],
  logins: [],
  preSetup: null,
};
const inputs: SetupInputs = { commit: "c1", setupBlob: "blob1" };

test("setupHashOf changes with .nexus/setup, preSetup, the effective allowlist and the disk size only", () => {
  const hash = setupHashOf(project, inputs);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(setupHashOf(project, { ...inputs, commit: "c2" }), hash, "a commit that leaves setup alone keeps the key");
  assert.equal(setupHashOf({ ...project, allowedHosts: ["registry.npmjs.org", "registry.npmjs.org"] }, inputs), hash);
  assert.equal(setupHashOf({ ...project, resources: { ...project.resources, cpus: 8, memoryGiB: 32 } }, inputs), hash, "CPUs and memory are the VM's, not the template's");
  for (const changed of [
    setupHashOf(project, { ...inputs, setupBlob: "blob2" }),
    setupHashOf(project, { ...inputs, setupBlob: null }),
    setupHashOf({ ...project, preSetup: "apt-get install -y jq" }, inputs),
    setupHashOf({ ...project, logins: ["claude"] }, inputs),
    setupHashOf({ ...project, secrets: [{ name: "K", hosts: ["api.stripe.com"] }] }, inputs),
    setupHashOf({ ...project, repoUrl: "https://github.com/ramtin/acme-web.git" }, inputs),
    setupHashOf({ ...project, resources: { ...project.resources, diskGiB: project.resources.diskGiB + 10 } }, inputs),
  ]) assert.notEqual(changed, hash);
});

const image: ImageId = "img-aaaaaaaaaaaa";
const oldImage: ImageId = "img-000000000000";
const key: TemplateKey = { project: project.id, image, setupHash: setupHashOf(project, inputs) };
const template = templateIdOf(key, node, now);

test("templateIdOf names one build: its key, its node and its start time", () => {
  assert.match(template, /^tpl-[0-9a-f]{12}$/);
  assert.equal(templateIdOf({ setupHash: key.setupHash, image, project: key.project }, node, now), template);
  assert.notEqual(templateIdOf({ ...key, image: oldImage }, node, now), template);
  assert.notEqual(templateIdOf(key, peer, now), template);
  assert.notEqual(templateIdOf(key, node, now + 1), template);
});

const checkout = { branch: "feature", commit: "c1" };
const buildMs = 10 * 60_000;
const buildInputs: TemplateBuildInputs = {
  key,
  repo: { url: project.repoUrl, branch: "feature", commit: "c1" },
  preSetup: null,
  allowedHosts: ["registry.npmjs.org"],
  resources: project.resources,
};
const ready = (builtAt: number, k = key, on = node): TemplateRecord & { state: "ready" } => ({ id: templateIdOf(k, on, builtAt - buildMs), key: k, state: "ready", builtOn: on, builtAt, commit: "c0" });
const buildingOn = (on: NodeName, k = key): TemplateRecord => ({ id: templateIdOf(k, on, now - buildMs), key: k, state: "building", on, inputs: { ...buildInputs, key: k }, submitted: null });
const building = buildingOn(node);
const failedOn = (on: NodeName): TemplateRecord => ({ id: templateIdOf(key, on, now - 2 * hour), key, state: "failed", on, failedAt: now - hour, logTail: "npm ERR! 404" });
const failed = failedOn(node);
const otherKey: TemplateKey = { ...key, setupHash: "other" };
const recent = ready(now - hour);
const older = ready(now - 2 * hour);

/** The target node holds every template it built, unless a case says otherwise. */
const choices: Record<string, [readonly TemplateRecord[], ReturnType<typeof chooseTemplate>, (readonly ArtifactId[])?]> = {
  "a fresh ready template the node holds is reused": [[recent], { kind: "reuse", template: recent.id, builtAt: recent.builtAt }],
  "the newest fresh ready template is reused": [[older, recent], { kind: "reuse", template: recent.id, builtAt: recent.builtAt }],
  "a ready template wins over a failed one": [[failed, recent], { kind: "reuse", template: recent.id, builtAt: recent.builtAt }],
  "a running build is waited for": [[building], { kind: "wait", template: building.id }],
  "a running build wins over a template past its age": [[ready(now - templateMaxAgeMs), building], { kind: "wait", template: building.id }],
  "a failed build boots fresh, with its log": [[failed], { kind: "fresh", reason: `the build of template ${failed.id} failed on ${node}: npm ERR! 404` }],
  "a template past its age is rebuilt": [[ready(now - templateMaxAgeMs)], build()],
  "another key's template is ignored": [[ready(now - hour, otherKey), buildingOn(node, otherKey)], build()],
  "no template is built on the target node": [[], build()],
  "a ready template built on another node is built again here": [[ready(now - hour, key, peer)], build()],
  "a ready template the node no longer holds is built again": [[recent], build(), []],
  "a build running on another node is not waited for": [[buildingOn(peer)], build()],
  "a build that failed on another node does not stop one here": [[failedOn(peer)], build()],
};

function build(): ReturnType<typeof chooseTemplate> {
  return { kind: "build", template, on: node, inputs: buildInputs };
}

for (const [name, [templates, expected, held]] of Object.entries(choices)) {
  test(`chooseTemplate: ${name}`, () => {
    assert.deepEqual(chooseTemplate(project, key, checkout, templates, node, held ?? templates.map((t) => t.id), now), expected);
  });
}

test("chooseTemplate builds with the effective allowlist, so setup can reach login and secret hosts", () => {
  const withLogin = { ...project, logins: ["chatgpt"] as const, secrets: [{ name: "K", hosts: ["api.stripe.com"] }] };
  const choice = chooseTemplate(withLogin, key, checkout, [], node, [], now);
  assert.equal(choice.kind, "build");
  assert.deepEqual(choice.kind === "build" && choice.inputs.allowedHosts, ["api.openai.com", "api.stripe.com", "auth.openai.com", "chatgpt.com", "registry.npmjs.org"]);
});

test("chooseTemplate builds with the host of an HTTPS repo on the allowlist, so setup can clone it", () => {
  const choice = chooseTemplate({ ...project, repoUrl: "https://github.com/ramtin/acme-web.git" }, key, checkout, [], node, [], now);
  assert.deepEqual(choice.kind === "build" && choice.inputs.allowedHosts, ["github.com", "registry.npmjs.org"]);
});

test("garbage drops aged templates that are not their project's newest ready one, and images nothing held needs", () => {
  const agedImage: ImageId = "img-222222222222";
  const unknownImage: ImageId = "img-ffffffffffff";
  const young = ready(now - hour, { ...key, setupHash: "young" });
  const aged = ready(now - 100 * hour, { ...key, setupHash: "aged" });
  const agedOnOldImage = ready(now - 200 * hour, { ...key, image: agedImage, setupHash: "aged-old-image" });
  const onlyOfItsProject = ready(now - 500 * hour, { project: "other" as ProjectId, image: oldImage, setupHash: "s" });
  const unknownTemplate = "tpl-ffffffffffff" as const;
  const checkpoint: CheckpointId = "ckpt-t1-1";
  const templates = [young, aged, agedOnOldImage, onlyOfItsProject, building, failed];
  const held: ArtifactId[] = [
    image, oldImage, agedImage, unknownImage, checkpoint,
    young.id, aged.id, agedOnOldImage.id, onlyOfItsProject.id, building.id, failed.id, unknownTemplate,
  ];
  assert.deepEqual(garbage(held, templates, { imageBuildNode: node, current: image }, now), [
    unknownImage, aged.id, agedOnOldImage.id, failed.id, unknownTemplate,
  ]);
});

test("garbage leaves a directory name that is no image or template ID, which no drop job may name", () => {
  const malformed = ["img-Old.partial", "img-", "tpl-..", "tpl-UPPER", `img-${"0".repeat(41)}`] as ArtifactId[];
  assert.deepEqual(garbage([image, oldImage, ...malformed], [], { imageBuildNode: node, current: image }, now), [oldImage]);
});

test("a rebuild after expiry gets a new ID, and garbage keeps the old one until the rebuild is ready", () => {
  const expired = ready(now - templateMaxAgeMs - hour);
  const choice = chooseTemplate(project, key, checkout, [expired], node, [expired.id], now);
  assert.ok(choice.kind === "build");
  assert.notEqual(choice.template, expired.id, "the bytes under the expired ID never change");

  const settings = { imageBuildNode: node, current: image };
  const rebuilding: TemplateRecord = { id: choice.template, key, state: "building", on: node, inputs: choice.inputs, submitted: null };
  assert.deepEqual(garbage([image, expired.id], [expired, rebuilding], settings, now), [], "the newest ready template of the project is kept");

  const later = now + buildMs;
  const rebuilt: TemplateRecord = { id: choice.template, key, state: "ready", builtOn: node, builtAt: later, commit: "c1" };
  assert.deepEqual(chooseTemplate(project, key, checkout, [expired, rebuilt], node, [expired.id, rebuilt.id], later), { kind: "reuse", template: choice.template, builtAt: later });
  assert.deepEqual(garbage([image, expired.id, rebuilt.id], [expired, rebuilt], settings, later), [expired.id]);
});

test("garbage keeps the image a running template build needs, before any template of it is held", () => {
  const buildImage: ImageId = "img-333333333333";
  const fresh = ready(now - hour);
  const buildingOnNewImage = buildingOn(node, { ...key, image: buildImage });
  const settings = { imageBuildNode: node, current: image };
  assert.deepEqual(garbage([image, buildImage, fresh.id], [fresh, buildingOnNewImage], settings, now), []);
  assert.deepEqual(garbage([image, buildImage, fresh.id], [fresh], settings, now), [buildImage]);
});

test("garbage drops an image on the pass after its last template is gone", () => {
  const agedImage: ImageId = "img-222222222222";
  const young = ready(now - hour);
  const aged = ready(now - 100 * hour, { ...key, image: agedImage, setupHash: "aged" });
  const settings = { imageBuildNode: node, current: image };
  assert.deepEqual(garbage([image, agedImage, young.id, aged.id], [young, aged], settings, now), [aged.id]);
  assert.deepEqual(garbage([image, agedImage, young.id], [young, aged], settings, now), [agedImage]);
});

test("garbage after a wiped registry drops templates and old images, never the current image or a checkpoint", () => {
  const held: ArtifactId[] = [image, oldImage, template, "ckpt-t1-1"];
  assert.deepEqual(garbage(held, [], { imageBuildNode: node, current: image }, now), [oldImage, template]);
});
