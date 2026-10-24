import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actualState, backoffMs, desiredPhase, envelope, idlePolicy, ingest, planPylon, requiredArtifacts,
  type ActivityFacts, type DesiredPhase, type PlanInput, type PlanStep, type RegistryWrite, type SessionRow,
} from "./reconcile.ts";
import {
  encodeProbeEvent, encodeSubmitReply, jobSubject, parseJobEnvelope, parseProbeEvent, parseSubmitReply,
  type JobErrorCode, type JobId, type JobStatus, type LiveHash, type NodeName, type NodeObservation, type ProbeEvent, type PylonId, type PylonObservation,
  type PausedSession, type RunningFacts, type SessionFact,
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
  repo: { kind: "clone", url: "git@example.com:r.git", checkout: { branch: "main", commit: "c0ffee" } },
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
};
const live = { previews: [], overlay: [] };

const running = (hash: LiveHash | null): PylonObservation => ({
  pylonId, phase: "running", liveHash: hash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image, checkpoint: null },
  services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
});
const stopped = (checkpoint: CheckpointId | null, sessions: readonly PausedSession[] | null = null): PylonObservation => ({ pylonId, phase: "stopped", checkpoint, sessions });
const broken: PylonObservation = { pylonId, phase: "broken", detail: "qcow2 header unreadable", cause: "controller" };
const brokenSetup: PylonObservation = { pylonId, phase: "broken", detail: "Setup exited 128. Read controller logs", cause: "setup" };
const brokenSavedSetup: PylonObservation = { ...brokenSetup, cause: "saved-setup" };
const brokenUnknown: PylonObservation = { ...broken, cause: "unknown" };
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
  previewsRouted?: boolean;
  /** A human retried the pylon. */
  retrying?: boolean;
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
  "delete of an absent pylon whose previews the node still routes submits delete": { desired: "deleted", observed: "absent", previewsRouted: true, inFlight: null, attempts: none, online: true, present: [], expect: del },
  "delete of a running pylon submits delete": { desired: "deleted", observed: running(liveHash), inFlight: null, attempts: none, online: true, present: imageOnly, expect: del },
  "delete ignores the attempt budget": { desired: "deleted", observed: stopped(lastCheckpoint), inFlight: null, attempts: [5, 1_000, "setup-failed"], online: true, present: imageOnly, expect: del },
  "delete does not wait for a transition": { desired: "deleted", observed: phase("stopping"), inFlight: null, attempts: none, online: true, present: imageOnly, expect: del },
  // 4
  "a non-retryable code fails": { desired: "running", observed: "absent", inFlight: null, attempts: [1, 60_000, "setup-failed"], online: true, present: imageOnly, expect: { kind: "fail", reason: "last job failed with setup-failed, which is not retryable: the probe's setup-failed message" } },
  "five failed attempts fail": { desired: "running", observed: "absent", inFlight: null, attempts: [5, 600_000, "backend"], online: true, present: imageOnly, expect: { kind: "fail", reason: "gave up after 5 failed attempts, the last with backend: the probe's backend message" } },
  "backoff waits": { desired: "running", observed: "absent", inFlight: null, attempts: [2, 10_000, "backend"], online: true, present: imageOnly, expect: wait("backoff") },
  "an elapsed backoff retries": { desired: "running", observed: "absent", inFlight: null, attempts: [1, 5_000, "deadline"], online: true, present: imageOnly, expect: spawn(fresh) },
  "backoff also holds a pause": { desired: "paused", observed: running(liveHash), inFlight: null, attempts: [3, 44_000, "checkpoint-failed"], online: true, present: imageOnly, expect: wait("backoff") },
  // 5
  "booting waits": { desired: "running", observed: phase("booting"), inFlight: null, attempts: none, online: true, present: imageOnly, expect: wait("transitioning") },
  "stopping waits": { desired: "running", observed: phase("stopping"), inFlight: null, attempts: none, online: true, present: imageOnly, expect: wait("transitioning") },
  "deleting waits": { desired: "paused", observed: phase("deleting"), inFlight: null, attempts: none, online: true, present: imageOnly, expect: wait("transitioning") },
  // 6
  "paused and absent is done": { desired: "paused", observed: "absent", inFlight: null, attempts: none, online: true, present: [], expect: done },
  "paused and absent is done though the node still routes its previews": { desired: "paused", observed: "absent", previewsRouted: true, inFlight: null, attempts: none, online: true, present: [], expect: done },
  "paused and stopped is done": { desired: "paused", observed: stopped(lastCheckpoint), inFlight: null, attempts: none, online: true, present: imageOnly, expect: done },
  "paused and running submits pause": { desired: "paused", observed: running(liveHash), inFlight: null, attempts: none, online: true, present: imageOnly, expect: pause },
  "paused and broken submits pause": { desired: "paused", observed: broken, inFlight: null, attempts: none, online: true, present: imageOnly, expect: pause },
  "paused and broken by a setup that failed on this boot submits pause, which removes the VM": { desired: "paused", observed: brokenSetup, inFlight: null, attempts: none, online: true, present: imageOnly, expect: pause },
  "paused and broken with a saved setup fails, since a pause would save the failure": { desired: "paused", observed: brokenSavedSetup, inFlight: null, attempts: none, online: true, present: imageOnly, expect: { kind: "fail", reason: "pylon is broken: Setup exited 128. Read controller logs. Its disk holds the failed setup, and every boot of that disk fails the same way, so a retry cannot help. Start again from the project" } },
  "paused and broken for a reason the node did not say fails rather than pausing": { desired: "paused", observed: brokenUnknown, inFlight: null, attempts: none, online: true, present: imageOnly, expect: { kind: "fail", reason: "pylon is broken: qcow2 header unreadable. The node did not say why the pylon broke in a way this control plane understands. Upgrade Nexus on the node and the control plane, or start again from the project" } },
  // 7a
  "running and stopped resumes from the checkpoint": { desired: "running", observed: stopped(lastCheckpoint), inFlight: null, attempts: none, online: true, present: imageOnly, expect: spawn({ kind: "resume", checkpoint: lastCheckpoint }) },
  "running and stopped without a checkpoint boots the first source": { desired: "running", observed: stopped(null), inFlight: null, attempts: none, online: true, present: imageOnly, expect: spawn(fresh) },
  "running and broken fails, never booting over the disk": { desired: "running", observed: broken, inFlight: null, attempts: none, online: true, present: imageOnly, expect: { kind: "fail", reason: "pylon is broken: qcow2 header unreadable" } },
  "a retried broken pylon pauses, to resume its newest disk": { desired: "running", observed: broken, inFlight: null, attempts: none, online: true, present: imageOnly, retrying: true, expect: pause },
  "a retried pylon whose setup failed on this boot pauses, which removes the VM and its failure": { desired: "running", observed: brokenSetup, inFlight: null, attempts: none, online: true, present: imageOnly, retrying: true, expect: pause },
  "a retried pylon whose disk holds a failed setup fails, since a resume would fail the same way": { desired: "running", observed: brokenSavedSetup, inFlight: null, attempts: none, online: true, present: imageOnly, retrying: true, expect: { kind: "fail", reason: "pylon is broken: Setup exited 128. Read controller logs. Its disk holds the failed setup, and every boot of that disk fails the same way, so a retry cannot help. Start again from the project" } },
  "a retried pylon that is not broken plans as usual": { desired: "running", observed: "absent", inFlight: null, attempts: none, online: true, present: imageOnly, retrying: true, expect: spawn(fresh) },
  "a retried pylon whose probe cannot say why it broke fails, never pausing it": { desired: "running", observed: brokenUnknown, inFlight: null, attempts: none, online: true, present: imageOnly, retrying: true, expect: { kind: "fail", reason: "pylon is broken: qcow2 header unreadable. The node did not say why the pylon broke in a way this control plane understands. Upgrade Nexus on the node and the control plane, or start again from the project" } },
  "a retried broken pylon still waits out its backoff": { desired: "running", observed: broken, inFlight: null, attempts: [1, 1_000, "backend"], online: true, present: imageOnly, retrying: true, expect: wait("backoff") },
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
    previewsRouted: row.previewsRouted ?? false,
    nodeArtifacts: new Set(row.present),
    inFlight: row.inFlight === null ? null : jobInFlight(row.inFlight),
    attempts: { count, last: lastCode === null ? null : { at: now - failedAgo!, code: lastCode, message: `the probe's ${lastCode} message` } },
    retrying: row.retrying ?? false,
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
  assert.equal(actualState("absent", null, true, false), "absent");
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

test("a probe takes a spawn whose repo is a clone or empty, and refuses one from a control plane older than scratch projects", () => {
  const spawnBody = (repo: unknown) => JSON.stringify(envelope({ kind: "spawn", pylonId, boot: { ...boot, repo, source: { kind: "fresh", preSetup: null } } as BootInputs, live, liveHash }, node, now));
  const clone = { kind: "clone", url: "git@example.com:r.git", checkout: { branch: "main", commit: "c0ffee" } };
  assert.deepEqual(parseJobEnvelope(spawnBody(clone)).job, { kind: "spawn", pylonId, boot: { ...boot, repo: clone, source: { kind: "fresh", preSetup: null } }, live, liveHash });
  const empty = { kind: "empty", branch: "main" };
  const scratch = parseJobEnvelope(spawnBody(empty)).job;
  assert.ok(scratch.kind === "spawn" && scratch.boot.repo.kind === "empty" && scratch.boot.repo.branch === "main");
  assert.throws(() => parseJobEnvelope(spawnBody({ url: clone.url, checkout: clone.checkout })), { message: "job.boot.repo has no kind, so the control plane that sent it is older than this probe. Upgrade the control plane, then its probes" });
  assert.throws(() => parseJobEnvelope(spawnBody({ kind: "fork", branch: "main" })), { message: "job.boot.repo.kind is not clone or empty" });
  assert.throws(() => parseJobEnvelope(spawnBody({ kind: "empty" })), { message: "job.boot.repo.branch is not a non-empty string" });
  assert.throws(() => parseJobEnvelope(spawnBody({ kind: "clone", url: clone.url })), { message: "job.boot.repo.checkout is not an object" });
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

test("a snapshot from a probe older than route reporting parses with its routes unknown", () => {
  const observation = { node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 }, artifacts: [], jobs: [], pylons: [] };
  const old = parseProbeEvent(encodeProbeEvent({ type: "snapshot", observation } as unknown as ProbeEvent));
  assert.ok(old.type === "snapshot" && old.observation.previewRoutes === null);
  const routes = [{ httpsPort: 10200, pylonId, service: "web" }];
  const current = parseProbeEvent(encodeProbeEvent({ type: "snapshot", observation: { ...observation, previewRoutes: routes } }));
  assert.ok(current.type === "snapshot" && current.observation.previewRoutes !== null);
  assert.deepEqual(current.observation.previewRoutes, routes);
  assert.throws(() => parseProbeEvent(encodeProbeEvent({ type: "snapshot", observation: { ...observation, previewRoutes: {} } } as unknown as ProbeEvent)), /previewRoutes is not an array/);
});

test("a broken pylon whose cause is missing, as from an older probe, or one this control plane does not know parses with its cause unknown", () => {
  const snapshot = (pylon: Record<string, unknown>) => encodeProbeEvent({ type: "snapshot", observation: {
    node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 }, artifacts: [], jobs: [], pylons: [pylon], previewRoutes: [],
  } } as unknown as ProbeEvent);
  const old = parseProbeEvent(snapshot({ pylonId, phase: "broken", detail: "Setup exited 128. Read controller logs" }));
  assert.ok(old.type === "snapshot");
  assert.deepEqual(old.observation.pylons, [{ pylonId, phase: "broken", detail: "Setup exited 128. Read controller logs", cause: "unknown" }]);
  const current = parseProbeEvent(snapshot({ pylonId, phase: "broken", detail: "Setup exited 128. Read controller logs", cause: "saved-setup" }));
  assert.ok(current.type === "snapshot" && current.observation.pylons[0]?.phase === "broken" && current.observation.pylons[0].cause === "saved-setup");
  const newer = parseProbeEvent(snapshot({ pylonId, phase: "broken", detail: "x", cause: "cosmic-ray" }));
  assert.ok(newer.type === "snapshot" && newer.observation.pylons[0]?.phase === "broken" && newer.observation.pylons[0].cause === "unknown");
});

test("a stopped pylon parses with the sessions its pause recorded, or null from a probe older than the field", () => {
  const event = (pylon: Record<string, unknown>) => parseProbeEvent(JSON.stringify({ type: "pylon", pylon }));
  const recorded = [{ id: "failed-0123456789ab", herdrPane: null, harness: "pi", harnessSessionId: null, title: "plan" }];
  assert.deepEqual(event({ pylonId, phase: "stopped", checkpoint: lastCheckpoint, sessions: recorded }), { type: "pylon", pylon: { pylonId, phase: "stopped", checkpoint: lastCheckpoint, sessions: recorded } });
  assert.deepEqual(event({ pylonId, phase: "stopped", checkpoint: lastCheckpoint }), { type: "pylon", pylon: { pylonId, phase: "stopped", checkpoint: lastCheckpoint, sessions: null } });
});

test("sessions from a probe older than session states parse as running in their panes", () => {
  const old = parseProbeEvent(JSON.stringify({ type: "pylon", pylon: { ...running(liveHash), sessions: [{ herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, status: "idle" }] } }));
  assert.ok(old.type === "pylon" && old.pylon.phase === "running");
  assert.deepEqual(old.pylon.sessions, [{ id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, status: "idle" }]);
});

const working: SessionFact = { id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", status: "working", title: "review" };
const idleShell: SessionFact = { id: "w2:p1", state: "running", herdrPane: "w2:p1", harness: "shell", harnessSessionId: null, status: "idle" };
const workingRow: SessionRow = { id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", title: "review", status: "working", message: null };
const idleShellRow: SessionRow = { id: "w2:p1", state: "running", herdrPane: "w2:p1", harness: "shell", harnessSessionId: null, title: null, status: "idle", message: null };
const pausedReview: PausedSession = { id: "w1:p1", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", title: "review" };
const pausedReviewRow: SessionRow = { ...pausedReview, state: "paused", status: null, message: null };
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
    { record: "sessions", pylonId, sessions: [workingRow, idleShellRow] },
    { record: "output", pylonId, kind: "branch", ref: "origin/feature" },
    { record: "output", pylonId, kind: "diff", ref: "h1" },
    { record: "output", pylonId, kind: "preview", ref: "web" },
    { record: "output", pylonId, kind: "file", ref: "o1" },
    { record: "output", pylonId, kind: "diff", ref: "o2" },
    { record: "preview", pylonId, service: "web", httpsPort: 8443, ready: true },
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
    { record: "sessions", pylonId, sessions: [{ ...workingRow, status: "done" }] },
    { record: "output", pylonId, kind: "diff", ref: "h2" },
  ] satisfies RegistryWrite[]);
});

test("ingest: sessions the probe could not read write nothing", () => {
  const before = runningWith({ sessions: [working, idleShell] });
  assert.deepEqual(ingest({ type: "pylon", pylon: runningWith({ sessions: null }) }, node, knows(before), now), []);
});

test("ingest: a pausing pylon keeps its sessions, makes its previews not ready, and retracts no output", () => {
  const before = runningWith({ sessions: [idleShell], previews: [{ service: "web", httpsPort: 8443, ready: true }] });
  assert.deepEqual(ingest({ type: "pylon", pylon: phase("stopping") }, node, knows(before), now), [
    { record: "preview", pylonId, service: "web", httpsPort: 8443, ready: false },
  ] satisfies RegistryWrite[]);
  const sessionWrites = (pylon: PylonObservation) => ingest({ type: "pylon", pylon }, node, knows(before), now).filter((w) => w.record.startsWith("session"));
  for (const p of ["booting", "deleting"] as const) assert.deepEqual(sessionWrites(phase(p)), [], `${p} writes no sessions`);
  assert.deepEqual(sessionWrites(broken), [], "a broken pylon writes no sessions either");
});

test("ingest: a stopped pylon lists what its pause recorded as paused, under the IDs they ran under", () => {
  const paneless: PausedSession = { id: "failed-0123456789ab", herdrPane: null, harness: "pi", harnessSessionId: "/s.jsonl", title: "plan" };
  assert.deepEqual(ingest({ type: "pylon", pylon: stopped(lastCheckpoint, [pausedReview, paneless]) }, node, knows(phase("stopping")), now), [
    { record: "sessions", pylonId, sessions: [pausedReviewRow, { ...paneless, state: "paused", status: null, message: null }] },
  ] satisfies RegistryWrite[]);
  const after = stopped(lastCheckpoint, [pausedReview]);
  assert.deepEqual(ingest({ type: "pylon", pylon: after }, node, knows(after), now), [], "the same list again writes nothing");
});

test("ingest: a stopped pylon that says nothing of its sessions pauses every session it had", () => {
  assert.deepEqual(ingest({ type: "pylon", pylon: stopped(lastCheckpoint) }, node, knows(phase("stopping")), now), [{ record: "sessions-paused", pylonId }]);
  assert.deepEqual(ingest({ type: "pylon", pylon: stopped(lastCheckpoint) }, node, knows(stopped(lastCheckpoint)), now), []);
  // Stored before stopped observations had the field.
  const older = { pylonId, phase: "stopped", checkpoint: lastCheckpoint } as PylonObservation;
  assert.deepEqual(ingest({ type: "pylon", pylon: older }, node, knows(phase("stopping")), now), [{ record: "sessions-paused", pylonId }]);
});

test("ingest: the first list after a wake replaces the paused sessions with their panes, and reports a failed one as failed", () => {
  const moved: SessionFact = { ...working, id: "w3:p1", herdrPane: "w3:p1", status: "idle" };
  const failed: SessionFact = { id: "failed-0123456789ab", state: "failed", herdrPane: null, harness: "pi", harnessSessionId: "/s.jsonl", status: "unknown", title: "plan", message: "pi exited 1" };
  assert.deepEqual(ingest({ type: "pylon", pylon: phase("booting") }, node, knows(stopped(lastCheckpoint, [pausedReview])), now), []);
  assert.deepEqual(ingest({ type: "pylon", pylon: runningWith({ sessions: [moved, failed] }) }, node, knows(phase("booting")), now), [
    { record: "sessions", pylonId, sessions: [
      { ...workingRow, id: "w3:p1", herdrPane: "w3:p1", status: "idle" },
      { id: "failed-0123456789ab", state: "failed", herdrPane: null, harness: "pi", harnessSessionId: "/s.jsonl", title: "plan", status: null, message: "pi exited 1" },
    ] },
  ] satisfies RegistryWrite[]);
  assert.deepEqual(ingest({ type: "pylon", pylon: runningWith({ sessions: null }) }, node, knows(phase("booting")), now), [], "an unread list leaves the paused rows");
});

test("ingest: a deleted pylon drops its sessions", () => {
  assert.deepEqual(ingest({ type: "snapshot", observation: {
    node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b1", capacity: { memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 500 },
    artifacts: [], jobs: [], pylons: [], previewRoutes: [],
  } }, node, knows(phase("deleting")), now).filter((w) => w.record === "sessions"), [{ record: "sessions", pylonId, sessions: [] }]);
});

test("ingest: a preview is ready while the running pylon reports it ready on its port", () => {
  const web = { service: "web", httpsPort: 8443 };
  const before = runningWith({ previews: [{ ...web, ready: true }, { service: "api", httpsPort: 8444, ready: false }] });
  assert.deepEqual(ingest({ type: "pylon", pylon: before }, node, knows(before), now), [], "an unchanged report writes nothing");
  assert.deepEqual(ingest({ type: "pylon", pylon: runningWith({ previews: [{ service: "api", httpsPort: 8444, ready: true }] }) }, node, knows(before), now), [
    { record: "output", pylonId, kind: "preview", ref: "api" },
    { record: "preview", pylonId, service: "api", httpsPort: 8444, ready: true },
    { record: "preview", pylonId, ...web, ready: false },
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
    previewRoutes: [],
  };
  const known = new Map<PylonId, PylonObservation | "absent">([[pylonId, "absent"], [gone, { ...runningWith({ sessions: [idleShell] }), pylonId: gone }]]);
  assert.deepEqual(ingest({ type: "snapshot", observation }, node, known, now), [
    { record: "node", node, state: "online", capacity: observation.capacity },
    { record: "job", status },
    { record: "activity", pylonId, human: now, agent: null },
    { record: "orphan", node, pylonId: "pylon-x" as PylonId },
    { record: "sessions", pylonId: gone, sessions: [] },
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
