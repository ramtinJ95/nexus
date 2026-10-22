import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actualState, backoffMs, desiredPhase, envelope, idlePolicy, ingest, planPylon, requiredArtifacts,
  type ActivityFacts, type DesiredPhase, type PlanInput, type PlanStep, type RegistryWrite,
} from "./reconcile.ts";
import {
  encodeSubmitReply, jobSubject, parseSubmitReply,
  type JobErrorCode, type JobId, type JobStatus, type LiveHash, type NodeName, type NodeObservation, type PylonId, type PylonObservation,
  type RunningFacts, type SessionFact,
} from "./protocol.ts";
import type { BootInputs, PylonSource } from "./project.ts";
import type { ArtifactId, CheckpointId, ImageId, TemplateId } from "./images.ts";

const now = 1_800_000_000_000;
const pylonId = "pylon-t1" as PylonId;
const node = "rj-firebat" as NodeName;
const peer = "infra-testbench" as NodeName;
const image: ImageId = "img-aaaaaaaaaaaa";
const template: TemplateId = "tpl-bbbbbbbbbbbb";
const lastCheckpoint: CheckpointId = "ckpt-t1-1";
const nextCheckpoint: CheckpointId = "ckpt-t1-2";
const liveHash = "hash-current" as LiveHash;

const boot: Omit<BootInputs, "source"> = {
  pylonId,
  image,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 },
  network: { allowedHosts: [], secrets: [] },
  repo: { url: "git@example.com:r.git", checkout: { branch: "main", commit: "c0ffee" } },
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
};
const live = { previews: [], overlay: [] };

const running = (hash: LiveHash | null): PylonObservation => ({
  pylonId, phase: "running", liveHash: hash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image, checkpoint: null },
  services: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
});
const stopped = (checkpoint: CheckpointId | null): PylonObservation => ({ pylonId, phase: "stopped", checkpoint });
const broken: PylonObservation = { pylonId, phase: "broken", detail: "qcow2 header unreadable" };
const phase = (p: "booting" | "stopping" | "deleting"): PylonObservation => ({ pylonId, phase: p });

const fresh: PylonSource & { kind: "fresh" } = { kind: "fresh", preSetup: null };
const fromTemplate: PylonSource & { kind: "template" } = { kind: "template", template };
const spawn = (source: PylonSource): PlanStep => ({ kind: "submit", job: { kind: "spawn", pylonId, boot: { ...boot, source }, live, liveHash } });
const pause: PlanStep = { kind: "submit", job: { kind: "pause", pylonId, checkpoint: nextCheckpoint } };
const del: PlanStep = { kind: "submit", job: { kind: "delete", pylonId } };
const fetch = (artifact: ArtifactId, from: NodeName): PlanStep => ({ kind: "submit", job: { kind: "fetch-artifact", artifact, from, sha256: `sha-${artifact}` } });
const done: PlanStep = { kind: "done" };
const wait = (reason: "node-offline" | "in-flight" | "backoff" | "transitioning"): PlanStep => ({ kind: "wait", reason });

const jobInFlight = (state: "running" | "succeeded"): JobStatus => state === "running"
  ? { jobId: "j1" as JobId, subject: pylonId, kind: "spawn", state, startedAt: "2027-01-01T00:00:00Z" }
  : { jobId: "j1" as JobId, subject: pylonId, kind: "spawn", state, finishedAt: "2027-01-01T00:00:00Z" };

/** [count, failed this many ms before now, last code]. */
type Attempts = readonly [number, number | null, JobErrorCode | null];

interface Row {
  desired: DesiredPhase;
  observed: PylonObservation | "absent";
  inFlight: "running" | "succeeded" | null;
  attempts: Attempts;
  online: boolean;
  /** Artifacts already on the pylon's node. */
  present: readonly ArtifactId[];
  expect: PlanStep;
  firstBoot?: typeof fresh | typeof fromTemplate;
  holders?: Partial<Record<ArtifactId, readonly NodeName[]>>;
}

const none: Attempts = [0, null, null];
const imageOnly = [image] as const;

const rows: Record<string, Row> = {
  // 1
  "node offline waits": { desired: "running", observed: "absent", inFlight: null, attempts: none, online: false, present: imageOnly, expect: wait("node-offline") },
  "node offline waits even for delete": { desired: "deleted", observed: running(liveHash), inFlight: null, attempts: none, online: false, present: imageOnly, expect: wait("node-offline") },
  // 2
  "a running job waits": { desired: "paused", observed: running(liveHash), inFlight: "running", attempts: none, online: true, present: imageOnly, expect: wait("in-flight") },
  "a finished job does not block": { desired: "running", observed: running(liveHash), inFlight: "succeeded", attempts: none, online: true, present: imageOnly, expect: done },
  // 3
  "delete of an absent pylon is done": { desired: "deleted", observed: "absent", inFlight: null, attempts: none, online: true, present: [], expect: done },
  "delete of a running pylon submits delete": { desired: "deleted", observed: running(liveHash), inFlight: null, attempts: none, online: true, present: imageOnly, expect: del },
  "delete ignores the attempt budget": { desired: "deleted", observed: stopped(lastCheckpoint), inFlight: null, attempts: [5, 1_000, "setup-failed"], online: true, present: imageOnly, expect: del },
  "delete does not wait for a transition": { desired: "deleted", observed: phase("stopping"), inFlight: null, attempts: none, online: true, present: imageOnly, expect: del },
  // 4
  "a non-retryable code fails": { desired: "running", observed: "absent", inFlight: null, attempts: [1, 60_000, "setup-failed"], online: true, present: imageOnly, expect: { kind: "fail", reason: "last job failed with setup-failed, which is not retryable" } },
  "five failed attempts fail": { desired: "running", observed: "absent", inFlight: null, attempts: [5, 600_000, "backend"], online: true, present: imageOnly, expect: { kind: "fail", reason: "gave up after 5 failed attempts, the last with backend" } },
  "backoff waits": { desired: "running", observed: "absent", inFlight: null, attempts: [2, 10_000, "backend"], online: true, present: imageOnly, expect: wait("backoff") },
  "an elapsed backoff retries": { desired: "running", observed: "absent", inFlight: null, attempts: [1, 5_000, "deadline"], online: true, present: imageOnly, expect: spawn(fresh) },
  "backoff also holds a pause": { desired: "paused", observed: running(liveHash), inFlight: null, attempts: [3, 44_000, "checkpoint-failed"], online: true, present: imageOnly, expect: wait("backoff") },
  // 5
  "booting waits": { desired: "running", observed: phase("booting"), inFlight: null, attempts: none, online: true, present: imageOnly, expect: wait("transitioning") },
  "stopping waits": { desired: "running", observed: phase("stopping"), inFlight: null, attempts: none, online: true, present: imageOnly, expect: wait("transitioning") },
  "deleting waits": { desired: "paused", observed: phase("deleting"), inFlight: null, attempts: none, online: true, present: imageOnly, expect: wait("transitioning") },
  // 6
  "paused and absent is done": { desired: "paused", observed: "absent", inFlight: null, attempts: none, online: true, present: [], expect: done },
  "paused and stopped is done": { desired: "paused", observed: stopped(lastCheckpoint), inFlight: null, attempts: none, online: true, present: imageOnly, expect: done },
  "paused and running submits pause": { desired: "paused", observed: running(liveHash), inFlight: null, attempts: none, online: true, present: imageOnly, expect: pause },
  "paused and broken submits pause": { desired: "paused", observed: broken, inFlight: null, attempts: none, online: true, present: imageOnly, expect: pause },
  // 7a
  "running and stopped resumes from the checkpoint": { desired: "running", observed: stopped(lastCheckpoint), inFlight: null, attempts: none, online: true, present: imageOnly, expect: spawn({ kind: "resume", checkpoint: lastCheckpoint }) },
  "running and stopped without a checkpoint boots the first source": { desired: "running", observed: stopped(null), inFlight: null, attempts: none, online: true, present: imageOnly, expect: spawn(fresh) },
  "running and broken fails, never booting over the disk": { desired: "running", observed: broken, inFlight: null, attempts: none, online: true, present: imageOnly, expect: { kind: "fail", reason: "pylon is broken: qcow2 header unreadable" } },
  // 7b
  "a missing image is fetched before the template, from the first holder": {
    desired: "running", observed: "absent", inFlight: null, attempts: none, online: true, present: [], firstBoot: fromTemplate,
    holders: { [image]: [peer, "third-node" as NodeName], [template]: [peer] }, expect: fetch(image, peer),
  },
  "a missing template is fetched once the image is present": {
    desired: "running", observed: "absent", inFlight: null, attempts: none, online: true, present: imageOnly, firstBoot: fromTemplate,
    holders: { [template]: [peer] }, expect: fetch(template, peer),
  },
  "no holder fails artifact-missing": {
    desired: "running", observed: "absent", inFlight: null, attempts: none, online: true, present: [], firstBoot: fromTemplate,
    holders: { [template]: [peer] }, expect: { kind: "fail", reason: `artifact-missing: no online node holds ${image}` },
  },
  "a resume needs only the image": { desired: "running", observed: stopped(lastCheckpoint), inFlight: null, attempts: none, online: true, present: imageOnly, firstBoot: fromTemplate, expect: spawn({ kind: "resume", checkpoint: lastCheckpoint }) },
  // 7c
  "running with a matching liveHash is done": { desired: "running", observed: running(liveHash), inFlight: null, attempts: none, online: true, present: imageOnly, expect: done },
  "running with an older liveHash re-submits spawn": { desired: "running", observed: running("hash-old" as LiveHash), inFlight: null, attempts: none, online: true, present: imageOnly, expect: spawn(fresh) },
  "a running pylon whose template is gone re-submits spawn without fetching": { desired: "running", observed: running("hash-old" as LiveHash), inFlight: null, attempts: none, online: true, present: imageOnly, firstBoot: fromTemplate, expect: spawn(fromTemplate) },
  "a running pylon with a matching liveHash needs no artifacts": { desired: "running", observed: running(liveHash), inFlight: null, attempts: none, online: true, present: [], firstBoot: fromTemplate, expect: done },
  "liveHash null after a probe restart re-submits spawn": { desired: "running", observed: running(null), inFlight: null, attempts: none, online: true, present: imageOnly, expect: spawn(fresh) },
  "absent boots from the template": { desired: "running", observed: "absent", inFlight: null, attempts: none, online: true, present: [image, template], firstBoot: fromTemplate, expect: spawn(fromTemplate) },
};

function input(row: Row): PlanInput {
  const [count, failedAgo, lastCode] = row.attempts;
  return {
    pylonId, node, boot, live, liveHash, nextCheckpoint,
    nodeOnline: row.online,
    desired: row.desired,
    firstBoot: row.firstBoot ?? fresh,
    observed: row.observed,
    nodeArtifacts: new Set(row.present),
    inFlight: row.inFlight === null ? null : jobInFlight(row.inFlight),
    attempts: { count, lastFailedAt: failedAgo === null ? null : now - failedAgo, lastCode },
    holders: (id) => row.holders?.[id] ?? [],
    artifactSha256: (id) => `sha-${id}`,
  };
}

for (const [name, row] of Object.entries(rows)) {
  test(`planPylon: ${name}`, () => {
    assert.deepEqual(planPylon(input(row), now), row.expect);
  });
}

test("backoffMs follows 5 s, 15 s, 45 s, 2 min, 2 min", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(backoffMs), [5_000, 15_000, 45_000, 120_000, 120_000, 120_000]);
  assert.throws(() => backoffMs(0), RangeError);
});

test("desiredPhase", () => {
  const long = now - 3_600_000;
  const facts = (f: Partial<ActivityFacts>): ActivityFacts => ({ status: "active", agentTurnRunning: false, lastAgentActivityAt: long, lastHumanActivityAt: long, ...f });
  const cases: [Partial<ActivityFacts>, DesiredPhase][] = [
    [{ status: "deleted", agentTurnRunning: true }, "deleted"],
    [{ status: "archived", lastHumanActivityAt: now }, "paused"],
    [{ agentTurnRunning: true }, "running"],
    [{ status: "idle", lastAgentActivityAt: now - idlePolicy.agentIdleMs + 1 }, "running"],
    [{ lastAgentActivityAt: now - idlePolicy.agentIdleMs }, "paused"],
    [{ lastHumanActivityAt: now - idlePolicy.humanIdleMs + 1 }, "running"],
    [{ lastHumanActivityAt: now - idlePolicy.humanIdleMs }, "paused"],
    [{}, "paused"],
  ];
  for (const [f, expected] of cases) assert.equal(desiredPhase(facts(f), now), expected, JSON.stringify(f));
});

test("requiredArtifacts lists the image first", () => {
  assert.deepEqual(requiredArtifacts({ ...boot, source: fromTemplate }), [image, template]);
  assert.deepEqual(requiredArtifacts({ ...boot, source: fresh }), [image]);
  assert.deepEqual(requiredArtifacts({ ...boot, source: { kind: "resume", checkpoint: lastCheckpoint } }), [image]);
});

test("actualState", () => {
  const pausing: JobStatus = { jobId: "j" as JobId, subject: pylonId, kind: "pause", state: "running", startedAt: "" };
  assert.equal(actualState(running(liveHash), pausing, false, false), "unknown");
  assert.equal(actualState(running(liveHash), pausing, true, true), "failed");
  assert.equal(actualState(running(liveHash), pausing, true, false), "pausing");
  assert.equal(actualState(running(liveHash), null, true, false), "running");
  assert.equal(actualState(stopped(lastCheckpoint), null, true, false), "paused");
  assert.equal(actualState("absent", null, true, false), "deleted");
  assert.equal(actualState(phase("booting"), null, true, false), "spawning");
});

test("envelope expires 30 s after issue", () => {
  const env = envelope({ kind: "delete", pylonId }, node, now);
  assert.match(env.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(env.node, node);
  assert.equal(Date.parse(env.notAfter) - Date.parse(env.issuedAt), 30_000);
  assert.equal(Date.parse(env.issuedAt), now);
  assert.notEqual(envelope({ kind: "delete", pylonId }, node, now).jobId, env.jobId);
});

test("jobSubject", () => {
  assert.equal(jobSubject({ kind: "pause", pylonId, checkpoint: nextCheckpoint }), pylonId);
  assert.equal(jobSubject({ kind: "build-image", image, recipe: { files: [], pins: {} as never } }), image);
  assert.equal(jobSubject({ kind: "drop-artifact", artifact: template }), template);
});

test("submit replies round-trip through the wire encoding", () => {
  const status: JobStatus = { jobId: "j" as JobId, subject: pylonId, kind: "delete", state: "succeeded", finishedAt: "2027-01-01T00:00:00Z" };
  for (const reply of [{ accepted: status }, { rejected: "busy", inFlight: "k" as JobId }, { rejected: "expired" }, { rejected: "invalid", message: "bad" }] as const) {
    const { status: code, body } = encodeSubmitReply(reply);
    assert.deepEqual(parseSubmitReply(code, body), reply);
  }
});

const working: SessionFact = { herdrPane: "p1", harness: "claude-code", harnessSessionId: "s1", status: "working" };
const idleShell: SessionFact = { herdrPane: "p2", harness: "shell", harnessSessionId: null, status: "idle" };
const runningWith = (facts: Partial<RunningFacts>): PylonObservation => ({ ...running(liveHash), ...facts } as PylonObservation);
const knows = (previous: PylonObservation | "absent" = "absent") => new Map([[pylonId, previous]]);

test("ingest: a new running pylon writes its sessions, derived outputs and activity", () => {
  const observed = runningWith({
    sessions: [working, idleShell],
    attachedClients: 1,
    git: { head: "h1", branch: "feature", dirty: true, branches: [{ name: "feature", head: "h1", pushedAs: "origin/feature" }, { name: "local", head: "h0", pushedAs: null }] },
    previews: [{ service: "web", httpsPort: 8443, ready: true }, { service: "api", httpsPort: 8444, ready: false }],
    declaredOutputs: [{ id: "o1", kind: "file", path: "shot.png", title: "Shot", sha256: "s" }, { id: "o2", kind: "diff", base: "h0", sha256: "d", title: null }],
  });
  assert.deepEqual(ingest({ type: "pylon", pylon: observed }, node, knows(), now), [
    { record: "session", pylonId, herdrPane: "p1", fact: working },
    { record: "session", pylonId, herdrPane: "p2", fact: idleShell },
    { record: "output", pylonId, kind: "branch", ref: "origin/feature" },
    { record: "output", pylonId, kind: "diff", ref: "h1" },
    { record: "output", pylonId, kind: "preview", ref: "web" },
    { record: "output", pylonId, kind: "file", ref: "o1" },
    { record: "output", pylonId, kind: "diff", ref: "o2" },
    { record: "activity", pylonId, human: now, agent: now },
  ] satisfies RegistryWrite[]);
});

test("ingest: an unchanged observation writes only the activity it still shows", () => {
  const observed = runningWith({ sessions: [working], git: { head: "h1", branch: "main", dirty: true, branches: [] } });
  assert.deepEqual(ingest({ type: "pylon", pylon: observed }, node, knows(observed), now), [{ record: "activity", pylonId, human: null, agent: now }]);
  const quiet = runningWith({ sessions: [idleShell] });
  assert.deepEqual(ingest({ type: "pylon", pylon: quiet }, node, knows(quiet), now), []);
});

test("ingest: changed and closed sessions, and a dirty tree at a new head", () => {
  const before = runningWith({ sessions: [working, idleShell], git: { head: "h1", branch: "main", dirty: true, branches: [] } });
  const after = runningWith({ sessions: [{ ...working, status: "done" }], git: { head: "h2", branch: "main", dirty: true, branches: [] } });
  assert.deepEqual(ingest({ type: "pylon", pylon: after }, node, knows(before), now), [
    { record: "session", pylonId, herdrPane: "p1", fact: { ...working, status: "done" } },
    { record: "session", pylonId, herdrPane: "p2", fact: null },
    { record: "output", pylonId, kind: "diff", ref: "h2" },
  ] satisfies RegistryWrite[]);
});

test("ingest: a pause closes every session and retracts no output", () => {
  const before = runningWith({ sessions: [idleShell], previews: [{ service: "web", httpsPort: 8443, ready: true }] });
  assert.deepEqual(ingest({ type: "pylon", pylon: phase("stopping") }, node, knows(before), now), [
    { record: "session", pylonId, herdrPane: "p2", fact: null },
  ] satisfies RegistryWrite[]);
});

test("ingest: a pylon the registry does not know is an orphan, and nothing else", () => {
  const stranger = { ...runningWith({ sessions: [working] }), pylonId: "pylon-x" as PylonId };
  assert.deepEqual(ingest({ type: "pylon", pylon: stranger }, node, knows(), now), [{ record: "orphan", node, pylonId: "pylon-x" as PylonId }]);
});

test("ingest: a snapshot writes the node, its jobs, its pylons, and closes known pylons it omits", () => {
  const status: JobStatus = { jobId: "j" as JobId, subject: pylonId, kind: "spawn", state: "running", startedAt: "2027-01-01T00:00:00Z" };
  const gone = "pylon-gone" as PylonId;
  const observation: NodeObservation = {
    node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b1",
    capacity: { memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 500 },
    artifacts: [image], jobs: [status],
    pylons: [runningWith({ attachedClients: 2 }), { pylonId: "pylon-x" as PylonId, phase: "booting" }],
  };
  const known = new Map<PylonId, PylonObservation | "absent">([[pylonId, "absent"], [gone, { ...runningWith({ sessions: [idleShell] }), pylonId: gone }]]);
  assert.deepEqual(ingest({ type: "snapshot", observation }, node, known, now), [
    { record: "node", node, state: "online", capacity: observation.capacity },
    { record: "job", status },
    { record: "activity", pylonId, human: now, agent: null },
    { record: "orphan", node, pylonId: "pylon-x" as PylonId },
    { record: "session", pylonId: gone, herdrPane: "p2", fact: null },
  ] satisfies RegistryWrite[]);
  assert.throws(() => ingest({ type: "snapshot", observation }, peer, known, now), /names node rj-firebat/);
});

test("ingest: job events and preview hits", () => {
  const status: JobStatus = { jobId: "j" as JobId, subject: pylonId, kind: "pause", state: "succeeded", finishedAt: "2027-01-01T00:00:00Z" };
  assert.deepEqual(ingest({ type: "job", status }, node, knows(), now), [{ record: "job", status }]);
  assert.deepEqual(ingest({ type: "preview-hit", pylonId, service: "web", at: "2027-01-01T00:00:05Z", login: "ramtin" }, node, knows(), now), [
    { record: "activity", pylonId, human: Date.parse("2027-01-01T00:00:05Z"), agent: null },
  ]);
});

test("ingest: a preview hit for a pylon the registry does not know is an orphan, not activity", () => {
  const stranger = "pylon-x" as PylonId;
  assert.deepEqual(ingest({ type: "preview-hit", pylonId: stranger, service: "web", at: "2027-01-01T00:00:05Z", login: null }, node, knows(), now), [
    { record: "orphan", node, pylonId: stranger },
  ]);
});
