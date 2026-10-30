import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tickTemplateBuild } from "./template-builds.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { chooseTemplate, type BuildingTemplate, type TemplateRecord } from "./templates.ts";
import type { ImageId, TemplateKey } from "../images.ts";
import type { ProjectId, RemoteProject } from "../project.ts";
import type { JobId, NodeName } from "../ids.ts";
import type { JobEnvelope, JobErrorCode, JobStatus, SubmitReply } from "../protocol/jobs.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import type { ProbeClient } from "../protocol/client.ts";
import { testObservation } from "../test-kit.ts";

const node = "rj-firebat" as NodeName;
const image: ImageId = "img-000000000000";
const project = "acme" as ProjectId;
const key: TemplateKey = { project, image, setupHash: "s".repeat(64) };
const commit = "c".repeat(40);
const building: BuildingTemplate = {
  id: "tpl-aaaaaaaaaaaa", key, state: "building", on: node, submitted: null,
  inputs: { key, repo: { url: "git@example.com:acme.git", branch: "main", commit }, preSetup: null, allowedHosts: [], resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 } },
};

const dir = await mkdtemp(join(tmpdir(), "nexus-template-builds-"));
after(() => rm(dir, { recursive: true }));

/** A probe whose jobs run until the test ends them. `refuse` makes it turn down the next submit. */
function fakeProbe() {
  const sent: JobEnvelope[] = [];
  const jobs = new Map<JobId, JobStatus>();
  let refusal: Exclude<SubmitReply, { accepted: JobStatus }> | null = null;
  const probe: ProbeClient = {
    node,
    async submit(env) {
      sent.push(env);
      if (refusal !== null) {
        const reply = refusal;
        refusal = null;
        return reply;
      }
      const status: JobStatus = { jobId: env.jobId, subject: building.id, kind: "build-template", state: "running", startedAt: new Date().toISOString() };
      jobs.set(env.jobId, status);
      return { accepted: status };
    },
    async job(jobId) { return jobs.get(jobId) ?? "unknown"; },
    observe: () => { throw new Error("unused"); },
    command: () => Promise.reject(new Error("unused")),
    stream: () => Promise.reject(new Error("unused")),
    manifest: () => Promise.reject(new Error("unused")),
    putSecret: () => Promise.reject(new Error("unused")),
    putPeers: () => Promise.reject(new Error("unused")),
    health: () => Promise.reject(new Error("unused")),
  };
  const ended = (jobId: JobId) => ({ jobId, subject: building.id, kind: "build-template" as const, finishedAt: new Date().toISOString() });
  return {
    probe, sent,
    succeed(jobId: JobId) { jobs.set(jobId, { ...ended(jobId), state: "succeeded" }); },
    fail(jobId: JobId, code: JobErrorCode, message: string, logTail: string) { jobs.set(jobId, { ...ended(jobId), state: "failed", code, message, logTail }); },
    refuse(reply: Exclude<SubmitReply, { accepted: JobStatus }>) { refusal = reply; },
  };
}

function setup(t: TestContext) {
  const path = join(dir, `${randomUUID()}.db`);
  let registry = openRegistry(path);
  t.after(() => registry.close());
  registry.saveTemplate(building);
  const fake = fakeProbe();
  const logged: string[] = [];
  return {
    fake, logged,
    get registry(): Registry { return registry; },
    stored: (): readonly TemplateRecord[] => registry.templates(project),
    /** One pass of the node's loop: every building record on the node, as the registry holds it, with this observation. */
    async pass(over: Partial<NodeObservation> | null = {}) {
      const observation = over === null ? null : testObservation(node, { probeBootId: "boot-1", artifacts: [image], ...over });
      for (const record of registry.buildingTemplates(node)) await tickTemplateBuild(record, { probe: fake.probe, observation, registry, log: (line) => logged.push(line) });
    },
    /** A control plane that stops and starts again on the same file. */
    restart() {
      registry.close();
      registry = openRegistry(path);
    },
  };
}

test("a build is sent once, and is ready only when it succeeded and its node lists the template", async (t) => {
  const s = setup(t);
  await s.pass();
  assert.equal(s.fake.sent.length, 1);
  const [sent] = s.fake.sent;
  assert.deepEqual([sent!.node, sent!.job], [node, { kind: "build-template", template: building.id, inputs: building.inputs }]);
  assert.deepEqual(s.stored(), [{ ...building, submitted: sent }], "the envelope is saved, so a restart asks about it");

  await s.pass();
  assert.equal(s.fake.sent.length, 1, "a running build is not sent again");

  s.fake.succeed(sent!.jobId);
  await s.pass();
  assert.equal(s.stored()[0]!.state, "building", "the observation does not list the template yet, so a start would not find it");

  const before = Date.now();
  await s.pass({ artifacts: [image, building.id] });
  const [ready] = s.stored();
  assert.ok(ready?.state === "ready" && ready.builtAt >= before && ready.builtAt <= Date.now());
  assert.deepEqual(ready, { id: building.id, key, state: "ready", builtOn: node, builtAt: ready.builtAt, commit });
  await s.pass({ artifacts: [image, building.id] });
  assert.equal(s.fake.sent.length, 1);
});

test("a job the observation lists as succeeded is taken from it", async (t) => {
  const s = setup(t);
  await s.pass();
  const { jobId } = s.fake.sent[0]!;
  await s.pass({ artifacts: [image, building.id], jobs: [{ jobId, subject: building.id, kind: "build-template", state: "succeeded", finishedAt: new Date().toISOString() }] });
  assert.equal(s.stored()[0]!.state, "ready");
});

test("a setup that fails leaves a failed record with the failure and its log", async (t) => {
  const s = setup(t);
  await s.pass();
  s.fake.fail(s.fake.sent[0]!.jobId, "setup-failed", `the setup of template ${building.id} failed: Setup exited 1`, "npm ERR! 404\n");
  await s.pass();
  const [failed] = s.stored();
  assert.ok(failed?.state === "failed");
  assert.deepEqual(failed, { id: building.id, key, state: "failed", on: node, failedAt: failed.failedAt, logTail: `the setup of template ${building.id} failed: Setup exited 1\nnpm ERR! 404` });
  assert.match(s.logged.join("\n"), /tpl-aaaaaaaaaaaa: the template build on rj-firebat failed with setup-failed/);
});

test("a build that fails for a reason a retry can pass removes its record, so the next start builds again", async (t) => {
  const s = setup(t);
  await s.pass();
  s.fake.fail(s.fake.sent[0]!.jobId, "backend", "the controller exited", "");
  await s.pass();
  assert.deepEqual(s.stored(), []);
  assert.match(s.logged.join("\n"), /failed with backend, so the next thread of its setup builds it again/);
});

test("a build the probe refuses as invalid fails, and one it is busy with is sent again on the next pass", async (t) => {
  const s = setup(t);
  s.fake.refuse({ rejected: "busy", inFlight: "j0" as JobId });
  await s.pass();
  assert.deepEqual(s.stored(), [building], "nothing is in flight after a busy refusal");
  await s.pass();
  assert.equal(s.fake.sent.length, 2);
  assert.equal(s.stored()[0]!.state, "building");

  const refused = setup(t);
  refused.fake.refuse({ rejected: "invalid", message: "job.inputs is not an object" });
  await refused.pass();
  assert.deepEqual(refused.stored().map((r) => r.state === "failed" && r.logTail), ["job.inputs is not an object"]);
});

test("an envelope the probe does not know is waited on until it expires, then sent again", async (t) => {
  const s = setup(t);
  const lost: JobEnvelope = { jobId: "lost" as JobId, node, issuedAt: new Date().toISOString(), notAfter: new Date(Date.now() + 60_000).toISOString(), job: { kind: "build-template", template: building.id, inputs: building.inputs } };
  s.registry.saveTemplate({ ...building, submitted: lost });
  await s.pass();
  assert.deepEqual([s.fake.sent.length, s.stored()], [0, [{ ...building, submitted: lost }]], "a submit from before a restart may still land");

  s.registry.saveTemplate({ ...building, submitted: { ...lost, notAfter: new Date(Date.now() - 1).toISOString() } });
  await s.pass();
  assert.deepEqual(s.stored(), [building]);
  await s.pass();
  assert.equal(s.fake.sent.length, 1);
  assert.notEqual(s.fake.sent[0]!.jobId, lost.jobId);
});

test("a control plane that restarts while the build runs asks the probe about it instead of sending it twice", async (t) => {
  const s = setup(t);
  await s.pass();
  s.restart();
  await s.pass();
  await s.pass();
  assert.equal(s.fake.sent.length, 1);
  s.fake.succeed(s.fake.sent[0]!.jobId);
  await s.pass({ artifacts: [image, building.id] });
  assert.equal(s.stored()[0]!.state, "ready");
});

test("nothing is sent while the node is offline", async (t) => {
  const s = setup(t);
  await s.pass(null);
  assert.deepEqual([s.fake.sent.length, s.stored()], [0, [building]]);
});

test("builds of one setup chosen on two nodes in the same millisecond are two records, and one's end leaves the other", async (t) => {
  const s = setup(t);
  const peer = "infra-testbench" as NodeName;
  const remote: RemoteProject = { id: project, repoUrl: building.inputs.repo.url, defaultBranch: "main", defaultNode: node, resources: building.inputs.resources, allowedHosts: [], secrets: [], logins: [], preSetup: null };
  const other: TemplateKey = { ...key, setupHash: "o".repeat(64) };
  const now = Date.now();
  const builds = [node, peer].map((on) => {
    const choice = chooseTemplate(remote, other, { branch: "main", commit }, s.registry.templates(project), on, [], now);
    assert.equal(choice.kind, "build", `a build is chosen on ${on}, which holds no template`);
    if (choice.kind !== "build") throw new Error("unreachable");
    const record: BuildingTemplate = { id: choice.template, key: other, state: "building", on: choice.on, inputs: choice.inputs, submitted: null };
    s.registry.saveTemplate(record);
    return record;
  });
  assert.notEqual(builds[0]!.id, builds[1]!.id);
  assert.deepEqual(s.registry.buildingTemplates(node).filter((b) => b.key.setupHash === other.setupHash), [builds[0]]);
  assert.deepEqual(s.registry.buildingTemplates(peer), [builds[1]]);
  s.registry.deleteTemplate(builds[0]!.id);
  assert.deepEqual(s.registry.buildingTemplates(peer), [builds[1]], "a retryable failure on one node forgets only that node's build");
});
