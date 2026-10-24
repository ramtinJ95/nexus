import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseTemplate, garbage, imageIdOf, setupHashOf, templateIdOf, templateMaxAgeMs,
  type ArtifactId, type CheckpointId, type ImageId, type ImageRecipe, type SetupInputs, type TemplateKey, type TemplateRecord,
} from "./images.ts";
import type { ProjectId, RemoteProject } from "./project.ts";
import type { NodeName } from "./protocol.ts";

const now = 1_800_000_000_000;
const hour = 3_600_000;
const node = "rj-firebat" as NodeName;
const peer = "infra-testbench" as NodeName;

const recipe: ImageRecipe = {
  files: [{ path: "Dockerfile", content: "FROM debian" }, { path: "gondolin.json", content: "{}" }],
  pins: {
    debianDigest: "sha256:d", node: "24.22.1", nodeSha256: "n", claudeCode: "2.0.0", pi: "1.4.0", herdr: "0.5.0",
    piEnv: "0.1.0", piEnvSha256: "e", gondolin: "0.13.0", alpineKernel: "6.18.58-0-virt", dotfilesCommon: "abc", gh: "2.103.2",
    ghSha256: "g", neovim: "0.12.6", neovimSha256: "v",
  },
};

test("imageIdOf names the recipe's content, whatever the order of its files and pins", () => {
  const id = imageIdOf(recipe);
  assert.match(id, /^img-[0-9a-f]{12}$/);
  const reordered: ImageRecipe = { files: [...recipe.files].reverse(), pins: Object.fromEntries(Object.entries(recipe.pins).reverse()) as ImageRecipe["pins"] };
  assert.equal(imageIdOf(reordered), id);
  assert.notEqual(imageIdOf({ ...recipe, files: [{ path: "Dockerfile", content: "FROM alpine" }, recipe.files[1]!] }), id);
  assert.notEqual(imageIdOf({ ...recipe, pins: { ...recipe.pins, pi: "1.4.1" } }), id);
});

test("imageIdOf refuses a recipe with two files at one path", () => {
  assert.throws(() => imageIdOf({ ...recipe, files: [...recipe.files, { path: "Dockerfile", content: "" }] }), /two files at Dockerfile/);
});

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
const inputs: SetupInputs = { commit: "c1", setupBlob: "blob1", services: null };

test("setupHashOf changes with .nexus/setup, preSetup and the effective allowlist only", () => {
  const hash = setupHashOf(project, inputs);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(setupHashOf(project, { ...inputs, commit: "c2", services: { services: {} } }), hash, "a commit that leaves setup alone keeps the key");
  assert.equal(setupHashOf({ ...project, allowedHosts: ["registry.npmjs.org", "registry.npmjs.org"] }, inputs), hash);
  for (const changed of [
    setupHashOf(project, { ...inputs, setupBlob: "blob2" }),
    setupHashOf(project, { ...inputs, setupBlob: null }),
    setupHashOf({ ...project, preSetup: "apt-get install -y jq" }, inputs),
    setupHashOf({ ...project, logins: ["claude"] }, inputs),
    setupHashOf({ ...project, secrets: [{ name: "K", hosts: ["api.stripe.com"] }] }, inputs),
    setupHashOf({ ...project, repoUrl: "https://github.com/ramtin/acme-web.git" }, inputs),
  ]) assert.notEqual(changed, hash);
});

const image: ImageId = "img-aaaaaaaaaaaa";
const oldImage: ImageId = "img-000000000000";
const key: TemplateKey = { project: project.id, image, setupHash: setupHashOf(project, inputs) };
const template = templateIdOf(key, now);

test("templateIdOf names one build: its key and its start time", () => {
  assert.match(template, /^tpl-[0-9a-f]{12}$/);
  assert.equal(templateIdOf({ setupHash: key.setupHash, image, project: key.project }, now), template);
  assert.notEqual(templateIdOf({ ...key, image: oldImage }, now), template);
  assert.notEqual(templateIdOf(key, now + 1), template);
});

const checkout = { branch: "feature", commit: "c1" };
const buildMs = 10 * 60_000;
const ready = (builtAt: number, k = key): TemplateRecord & { state: "ready" } => ({ id: templateIdOf(k, builtAt - buildMs), key: k, state: "ready", builtOn: peer, builtAt, commit: "c0" });
const building: TemplateRecord = { id: templateIdOf(key, now - buildMs), key, state: "building", on: peer };
const failed: TemplateRecord = { id: templateIdOf(key, now - 2 * hour), key, state: "failed", on: peer, failedAt: now - hour, logTail: "npm ERR! 404" };
const otherKey: TemplateKey = { ...key, setupHash: "other" };
const recent = ready(now - hour);
const older = ready(now - 2 * hour);

const choices: Record<string, [readonly TemplateRecord[], ReturnType<typeof chooseTemplate>]> = {
  "a fresh ready template is reused, whichever node built it": [[recent], { kind: "reuse", template: recent.id }],
  "the newest fresh ready template is reused": [[older, recent], { kind: "reuse", template: recent.id }],
  "a ready template wins over a failed one": [[failed, recent], { kind: "reuse", template: recent.id }],
  "a running build is waited for": [[building], { kind: "wait", template: building.id }],
  "a running build wins over a template past its age": [[ready(now - templateMaxAgeMs), building], { kind: "wait", template: building.id }],
  "a failed build boots fresh, with its log": [[failed], { kind: "fresh", reason: `the setup of template ${failed.id} failed on ${peer}:\nnpm ERR! 404` }],
  "a template past its age is rebuilt": [[ready(now - templateMaxAgeMs)], build()],
  "another key's template is ignored": [[ready(now - hour, otherKey), { ...building, id: templateIdOf(otherKey, now), key: otherKey }], build()],
  "no template is built on the target node": [[], build()],
};

function build(): ReturnType<typeof chooseTemplate> {
  return {
    kind: "build",
    template,
    on: node,
    inputs: {
      key,
      repo: { url: project.repoUrl, branch: "feature", commit: "c1" },
      preSetup: null,
      allowedHosts: ["registry.npmjs.org"],
      resources: project.resources,
    },
  };
}

for (const [name, [templates, expected]] of Object.entries(choices)) {
  test(`chooseTemplate: ${name}`, () => {
    assert.deepEqual(chooseTemplate(project, key, checkout, templates, node, now), expected);
  });
}

test("chooseTemplate builds with the effective allowlist, so setup can reach login and secret hosts", () => {
  const withLogin = { ...project, logins: ["chatgpt"] as const, secrets: [{ name: "K", hosts: ["api.stripe.com"] }] };
  const choice = chooseTemplate(withLogin, key, checkout, [], node, now);
  assert.equal(choice.kind, "build");
  assert.deepEqual(choice.kind === "build" && choice.inputs.allowedHosts, ["api.openai.com", "api.stripe.com", "auth.openai.com", "chatgpt.com", "registry.npmjs.org"]);
});

test("chooseTemplate builds with the host of an HTTPS repo on the allowlist, so setup can clone it", () => {
  const choice = chooseTemplate({ ...project, repoUrl: "https://github.com/ramtin/acme-web.git" }, key, checkout, [], node, now);
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

test("a rebuild after expiry gets a new ID, and garbage keeps the old one until the rebuild is ready", () => {
  const expired = ready(now - templateMaxAgeMs - hour);
  const choice = chooseTemplate(project, key, checkout, [expired], node, now);
  assert.ok(choice.kind === "build");
  assert.notEqual(choice.template, expired.id, "the bytes under the expired ID never change");

  const settings = { imageBuildNode: node, current: image };
  const rebuilding: TemplateRecord = { id: choice.template, key, state: "building", on: node };
  assert.deepEqual(garbage([image, expired.id], [expired, rebuilding], settings, now), [], "the newest ready template of the project is kept");

  const later = now + buildMs;
  const rebuilt: TemplateRecord = { id: choice.template, key, state: "ready", builtOn: node, builtAt: later, commit: "c1" };
  assert.deepEqual(chooseTemplate(project, key, checkout, [expired, rebuilt], node, later), { kind: "reuse", template: choice.template });
  assert.deepEqual(garbage([image, expired.id, rebuilt.id], [expired, rebuilt], settings, later), [expired.id]);
});

test("garbage keeps the image a running template build needs, before any template of it is held", () => {
  const buildImage: ImageId = "img-333333333333";
  const fresh = ready(now - hour);
  const buildingOnNewImage: TemplateRecord = { id: templateIdOf({ ...key, image: buildImage }, now), key: { ...key, image: buildImage }, state: "building", on: node };
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
