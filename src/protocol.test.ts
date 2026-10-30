import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  connectProbe, parseArtifactManifest, parseJobEnvelope, parseProbeEvent, parsePylonCommand, parseStreamRequest, parseSubmitReply, ProbeHttpError,
  type NodeName, type PylonCommand, type PylonId, type TailnetNodeId,
} from "./protocol.ts";

const node = "test-node";
const pylonId = "pylon-th-1";
const image = "img-abc123";
const template = "tpl-def456";
const hex = "ab".repeat(32);
const unknown = { zzUnknown: { from: "a newer peer" } };
const boot = (source: unknown, repo: unknown) => ({
  pylonId, image, source, repo, resources: { cpus: 2, memoryGiB: 4, diskGiB: 20 }, network: { allowedHosts: [], secrets: [] }, dotfiles: { repo: "https://example.com/d.git", ref: "main" },
});
const clone = { kind: "clone", url: "https://github.com/acme/app.git", checkout: { branch: "main", commit: "c0ffee" } };
const live = { previews: [], overlay: [] };
const spawn = { kind: "spawn", pylonId, boot: boot({ kind: "fresh", preSetup: null }, clone), live, liveHash: "hash-1" };
const jobs = [
  spawn,
  { kind: "spawn", pylonId, boot: { ...boot({ kind: "fresh", preSetup: "apt-get install -y jq" }, { kind: "empty", branch: "main" }), ...unknown }, live: { ...live, ...unknown }, liveHash: "h", relaunch: false },
  { kind: "spawn", pylonId, boot: boot({ kind: "template", template, ...unknown }, { ...clone, ...unknown }), live, liveHash: "h" },
  { kind: "spawn", pylonId, boot: boot({ kind: "resume", checkpoint: "ckpt-1" }, { kind: "empty", branch: "main" }), live, liveHash: "h" },
  { kind: "pause", pylonId, checkpoint: "ckpt-abc" },
  { kind: "delete", pylonId, ...unknown },
  { kind: "build-image", image, recipe: { pins: { node: "24" } } },
  { kind: "build-template", template, inputs: {} },
  { kind: "fetch-artifact", artifact: image, from: "rj-firebat", sha256: hex },
  { kind: "fetch-artifact", artifact: template, from: "rj-firebat", sha256: hex },
  { kind: "fetch-artifact", artifact: "ckpt-abc", from: "rj-firebat", sha256: hex },
  { kind: "drop-artifact", artifact: image },
  { kind: "drop-artifact", artifact: template },
];
const envelope = (job: unknown) => ({ jobId: "job-1", node, issuedAt: "2027-01-01T00:00:00Z", notAfter: "2027-01-01T00:00:30Z", job });

test("a probe takes an envelope of every job kind as it was sent, with the fields it does not know", () => {
  for (const job of jobs) assert.deepEqual(parseJobEnvelope(JSON.stringify(envelope(job))), envelope(job));
  assert.deepEqual(parseJobEnvelope(JSON.stringify({ ...envelope(jobs[5]), ...unknown })), { ...envelope(jobs[5]), ...unknown });
});

test("a probe refuses an envelope that fails any check of its fields", () => {
  const without = (value: object, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
  const bad: unknown[] = [
    null, [], "x",
    { ...envelope(spawn), issuedAt: "yesterday" }, { ...envelope(spawn), notAfter: 1 }, { ...envelope(spawn), jobId: "" }, without(envelope(spawn), "node"), { ...envelope(spawn), job: [] },
    ...[
      { ...spawn, pylonId: "" }, { ...spawn, boot: { ...spawn.boot, pylonId: "pylon-other" } }, { ...spawn, boot: { ...spawn.boot, image: "img-ABC" } },
      { ...spawn, boot: { ...spawn.boot, image: `img-${"a".repeat(41)}` } }, { ...spawn, boot: { ...spawn.boot, source: { kind: "snapshot" } } },
      { ...spawn, boot: { ...spawn.boot, source: { kind: "template", template: image } } }, { ...spawn, boot: { ...spawn.boot, source: { kind: "fresh" } } },
      { ...spawn, boot: { ...spawn.boot, source: { kind: "fresh", preSetup: "" } } }, { ...spawn, boot: { ...spawn.boot, repo: { url: clone.url, checkout: clone.checkout } } },
      { ...spawn, boot: { ...spawn.boot, repo: { kind: "fork" } } }, { ...spawn, boot: { ...spawn.boot, repo: { kind: "clone", url: clone.url, checkout: { branch: "main" } } } },
      { ...spawn, boot: { ...spawn.boot, repo: { kind: "empty", branch: "" } } }, { ...spawn, live: { previews: [] } }, { ...spawn, live: { previews: {}, overlay: [] } },
      without(spawn, "liveHash"), { ...spawn, relaunch: true }, { ...spawn, relaunch: null },
      { kind: "pause", pylonId, checkpoint: "abc" }, { kind: "pause", checkpoint: "ckpt-1" }, { kind: "delete", pylonId: 1 },
      { kind: "build-image", image: template, recipe: {} }, { kind: "build-image", image, recipe: [] }, { kind: "build-template", template: image, inputs: {} }, { kind: "build-template", template },
      { kind: "fetch-artifact", artifact: pylonId, from: "n", sha256: hex }, { kind: "fetch-artifact", artifact: image, sha256: hex }, { kind: "fetch-artifact", artifact: image, from: "n", sha256: hex.toUpperCase() },
      { kind: "drop-artifact", artifact: "ckpt-abc" }, { kind: "migrate", pylonId }, { pylonId },
    ].map(envelope),
  ];
  for (const value of bad) assert.throws(() => parseJobEnvelope(JSON.stringify(value)), Error, JSON.stringify(value));
  assert.throws(() => parseJobEnvelope("{"), Error);
});

test("a bad request's message names each wrong field from the top of the payload, and what is wrong with it", () => {
  const { jobId: _, ...noJobId } = envelope({ kind: "migrate", pylonId });
  assert.throws(() => parseJobEnvelope(JSON.stringify(noJobId)), {
    message: "envelope.jobId: Invalid input: expected string, received undefined; envelope.job.kind: Invalid discriminator value. Expected 'spawn' | 'pause' | 'delete' | 'build-image' | 'build-template' | 'fetch-artifact' | 'drop-artifact'",
  });
  assert.throws(() => parseJobEnvelope(JSON.stringify(envelope({ ...spawn, boot: { ...spawn.boot, image: "img-ABC" } }))), { message: "envelope.job.boot.image: expected an image ID" });
  assert.throws(() => parsePylonCommand(JSON.stringify({ kind: "exec", argv: ["ls", 1], cwd: "home", timeoutMs: 60_001 })), {
    message: "command.argv[1]: Invalid input: expected string, received number; command.cwd: expected an absolute path; command.timeoutMs: Too big: expected number to be <=60000",
  });
  assert.throws(() => parsePylonCommand(JSON.stringify({ kind: "send-claude", session: "s-1", text: "a\tb" })), { message: /^command\.text: .*Replace tabs with spaces/ });
  assert.throws(() => parsePylonCommand("[]"), { message: "command: Invalid input: expected object, received array" });
  assert.throws(() => parsePylonCommand("not json"), { message: /^command: Unexpected token/ });
  const stream = (request: unknown) => new URL(`/v1/pylons/${pylonId}/stream?request=${encodeURIComponent(JSON.stringify(request))}`, "http://probe");
  assert.throws(() => parseStreamRequest("nexus-stream", stream({ argv: [] })), { message: "request.argv: Too small: expected array to have >=1 items" });
});

test("a job error code or a harness is one Nexus names, not any key an object holds", () => {
  const status = { jobId: "job-1", subject: image, kind: "build-image", state: "failed", finishedAt: "2027-01-01T00:00:00Z", message: "m", logTail: "" };
  for (const code of ["toString", "constructor", "__proto__"]) {
    assert.throws(() => parseProbeEvent(JSON.stringify({ type: "job", status: { ...status, code } })), { message: /^event\.status\.code: Invalid option/ });
  }
  assert.throws(() => parsePylonCommand(JSON.stringify({ kind: "open-session", harness: "toString", title: "x" })), { message: /^command\.harness: / });
});

test("a probe names the harness field a session open or close fails on, and why", () => {
  const messages = [
    { kind: "open-session", harness: "codex", title: "x" },
    { kind: "open-session", harness: "pi", title: "x", model: "m" },
    { kind: "open-session", harness: "pi", title: "x", prompt: "p" },
    { kind: "open-session", harness: "shell", title: "x", model: "m" },
    { kind: "open-session", harness: "shell", title: "x", resume: "s" },
    { kind: "close-session", herdrPane: "w1:p1", session: { harness: "codex", harnessSessionId: null, title: null } },
  ].map((command) => {
    try {
      parsePylonCommand(JSON.stringify(command));
    } catch (err) {
      return (err as Error).message;
    }
    return assert.fail(`${JSON.stringify(command)} was taken`);
  });
  assert.deepEqual(messages, [
    "command.harness: Invalid discriminator value. Expected 'claude-code' | 'pi' | 'shell'",
    "command.model: only a Claude Code session takes it",
    "command.prompt: only a Claude Code session takes it",
    "command.model: only a Claude Code session takes it",
    "command.resume: a shell session has nothing to resume",
    'command.session.harness: Invalid option: expected one of "claude-code"|"pi"|"shell"',
  ]);
});

const commands: PylonCommand[] = [
  { kind: "exec", argv: ["git", "status"], cwd: "/home/user", timeoutMs: 60_000 },
  { kind: "exec", argv: ["true"], cwd: "/", timeoutMs: 1 },
  { kind: "open-session", harness: "claude-code", title: "review", resume: "s-1", prompt: "p".repeat(16_384), model: "m".repeat(200) },
  { kind: "open-session", harness: "pi", title: "plan", resume: "/home/user/.pi/s.jsonl" },
  { kind: "open-session", harness: "shell", title: "sh" },
  { kind: "close-session", herdrPane: "w1:p1" },
  { kind: "close-session", herdrPane: "w1:p1", session: { harness: "claude-code", harnessSessionId: "s-1", title: "review" } },
  { kind: "close-session", herdrPane: "w1:p1", session: { harness: "shell", harnessSessionId: null, title: null } },
  { kind: "drop-failed-session", id: "failed-0123456789ab" },
  { kind: "send-claude", session: "s".repeat(200), text: "t".repeat(16_383) + "\n", model: "opus", requestId: "r-1" },
  { kind: "send-claude", session: "0b1c-2d3e", text: "hi" },
  { kind: "send-claude-outcome", requestId: "r-1" },
  { kind: "service", op: "logs", name: "web", lines: 1 },
  { kind: "service", op: "ensure" },
  { kind: "link-port", port: 65_535 },
  { kind: "unlink-port", port: 1 },
  { kind: "interrupt-claude", session: "0b1c-2d3e" },
];

test("a probe takes a command of every kind as it was sent, with the fields it does not know", () => {
  for (const command of commands) assert.deepEqual(parsePylonCommand(JSON.stringify(command)), command);
  for (const command of commands) assert.deepEqual(parsePylonCommand(JSON.stringify({ ...command, ...unknown })), { ...command, ...unknown });
  const named = { kind: "close-session", herdrPane: "w1:p1", session: { harness: "pi", harnessSessionId: null, title: "plan", ...unknown } };
  assert.deepEqual(parsePylonCommand(JSON.stringify(named)), named);
});

test("a probe refuses a command that fails any check of its fields", () => {
  const exec = { kind: "exec", argv: ["ls"], cwd: "/", timeoutMs: 1000 };
  const send = { kind: "send-claude", session: "s-1", text: "hi" };
  const bad: unknown[] = [
    null, [], { kind: "reboot" }, {},
    { ...exec, argv: [] }, { ...exec, argv: "ls" }, { ...exec, argv: ["ls", 1] }, { ...exec, cwd: "home" }, { ...exec, cwd: "" }, { ...exec, timeoutMs: 0 }, { ...exec, timeoutMs: 60_001 }, { ...exec, timeoutMs: 1.5 }, { ...exec, timeoutMs: "100" },
    { kind: "open-session", harness: "codex", title: "x" }, { kind: "open-session", harness: "shell" }, { kind: "open-session", harness: "shell", title: "" }, { kind: "open-session", harness: "shell", title: "x", resume: "s" },
    { kind: "open-session", harness: "pi", title: "x", model: "m" }, { kind: "open-session", harness: "pi", title: "x", prompt: "p" }, { kind: "open-session", harness: "claude-code", title: "x", model: "m".repeat(201) },
    { kind: "open-session", harness: "claude-code", title: "x", prompt: "p".repeat(16_385) }, { kind: "open-session", harness: "claude-code", title: "x", prompt: "" }, { kind: "open-session", harness: "pi", title: "x", resume: 1 },
    { kind: "close-session" }, { kind: "close-session", herdrPane: "w1:p1", session: null }, { kind: "close-session", herdrPane: "w1:p1", session: { harness: "codex", harnessSessionId: null, title: null } },
    { kind: "close-session", herdrPane: "w1:p1", session: { harness: "pi", title: null } }, { kind: "close-session", herdrPane: "w1:p1", session: { harness: "pi", harnessSessionId: null } },
    { kind: "drop-failed-session" }, { kind: "drop-failed-session", id: "" },
    { ...send, session: "a/b" }, { ...send, session: "s".repeat(201) }, { ...send, session: 1 }, { ...send, text: "" }, { ...send, text: "t".repeat(16_385) }, { ...send, text: "a\tb" }, { ...send, text: "a\u001b[31mb" },
    { ...send, model: "m".repeat(201) }, { ...send, model: "" }, { ...send, requestId: "" }, { kind: "send-claude-outcome" },
    { kind: "interrupt-claude" }, { kind: "interrupt-claude", session: "a/b" }, { kind: "interrupt-claude", session: "s".repeat(201) },
    { kind: "service", op: "start" }, { kind: "service", op: "logs", name: "" }, { kind: "service", op: "logs", lines: 0 }, { kind: "service", op: "logs", lines: 1.5 },
    { kind: "link-port", port: 0 }, { kind: "link-port", port: 65_536 }, { kind: "link-port", port: "80" }, { kind: "link-port", port: 22 }, { kind: "unlink-port", port: 22 },
  ];
  for (const value of bad) assert.throws(() => parsePylonCommand(JSON.stringify(value)), Error, JSON.stringify(value));
  assert.throws(() => parsePylonCommand("not json"), Error);
});

test("a stream request names its pylon and argv, and nothing else it holds", () => {
  const url = (request: unknown, path = `/v1/pylons/${pylonId}/stream`) => new URL(`${path}?request=${encodeURIComponent(JSON.stringify(request))}`, "http://probe");
  assert.deepEqual(parseStreamRequest("nexus-stream", url({ argv: ["pi-env", "serve"] })), { pylonId, argv: ["pi-env", "serve"] });
  assert.deepEqual(parseStreamRequest("Nexus-Stream", url({ argv: ["sh"], pty: null, ...unknown })), { pylonId, argv: ["sh"] });
  assert.deepEqual(parseStreamRequest("nexus-stream", url({ argv: ["sh"] }, "/v1/pylons/pylon%2Dth%2D1/stream")), { pylonId, argv: ["sh"] });
  assert.equal(parseStreamRequest("websocket", url({ argv: ["sh"] })), null);
  assert.equal(parseStreamRequest(undefined, url({ argv: ["sh"] })), null);
  assert.equal(parseStreamRequest("nexus-stream", url({ argv: [] }, `/v1/pylons/${pylonId}/streams`)), null);
  for (const request of [null, [], {}, { argv: [] }, { argv: "sh" }, { argv: ["sh", 1] }, { argv: ["sh"], pty: { rows: 24 } }, { argv: ["sh"], pty: false }]) {
    assert.throws(() => parseStreamRequest("nexus-stream", url(request)), Error, JSON.stringify(request));
  }
  assert.throws(() => parseStreamRequest("nexus-stream", new URL(`/v1/pylons/${pylonId}/stream`, "http://probe")));
  assert.throws(() => parseStreamRequest("nexus-stream", new URL(`/v1/pylons/${pylonId}/stream?request=%7B`, "http://probe")), Error);
});

const running = { jobId: "job-1", subject: pylonId, kind: "spawn", state: "running", startedAt: "2027-01-01T00:00:00Z" };
const failed = { jobId: "job-1", subject: image, kind: "build-image", state: "failed", finishedAt: "2027-01-01T00:00:00Z", code: "setup-failed", message: "exit 1", logTail: "" };

test("a submit reply is read by its status, without the fields the control plane does not know", () => {
  assert.deepEqual(parseSubmitReply(200, JSON.stringify({ accepted: { ...running, ...unknown }, ...unknown })), { accepted: { ...running, ...unknown } });
  assert.deepEqual(parseSubmitReply(409, JSON.stringify({ rejected: "busy", inFlight: "job-0", ...unknown })), { rejected: "busy", inFlight: "job-0" });
  assert.deepEqual(parseSubmitReply(410, JSON.stringify({ rejected: "expired", ...unknown })), { rejected: "expired" });
  assert.deepEqual(parseSubmitReply(400, JSON.stringify({ rejected: "invalid", message: "m", ...unknown })), { rejected: "invalid", message: "m" });
  const bad: [number, unknown][] = [
    [200, { accepted: { ...running, state: "paused" } }], [200, { rejected: "busy", inFlight: "j" }], [409, { rejected: "busy" }], [409, { rejected: "busy", inFlight: "" }],
    [409, { rejected: "expired" }], [400, { rejected: "invalid" }], [400, { rejected: "busy", inFlight: "j" }], [500, { rejected: "expired" }], [200, []], [200, null],
  ];
  for (const [status, reply] of bad) assert.throws(() => parseSubmitReply(status, JSON.stringify(reply)), Error, `${status} ${JSON.stringify(reply)}`);
});

const observation = {
  events: [{ sequence: 1, pylon: pylonId, event: { kind: "session.turn-ended" }, time: 2 }], node, observedAt: "2027-01-01T00:00:00Z", probeBootId: "b",
  capacity: { cpus: 8, committedCpus: 2, memoryGiB: 32, committedMemoryGiB: 4, diskFreeGiB: 100, committedDiskGiB: 20 }, artifacts: [image], jobs: [running, failed],
  pylons: [{ pylonId, phase: "booting", ...unknown }, { pylonId: "pylon-t2", phase: "stopped", checkpoint: null, sessions: null }], previewRoutes: [{ httpsPort: 8443, pylonId, service: "web" }],
  grants: { secrets: [], gitSsh: false }, heldSecrets: [], ...unknown,
};

test("a probe event keeps the fields the control plane does not know inside its payload, and only there for a snapshot or a pylon", () => {
  assert.deepEqual(parseProbeEvent(JSON.stringify({ type: "snapshot", observation, ...unknown })), { type: "snapshot", observation });
  assert.deepEqual(parseProbeEvent(JSON.stringify({ type: "pylon", pylon: { pylonId, phase: "deleting", ...unknown }, ...unknown })), { type: "pylon", pylon: { pylonId, phase: "deleting", ...unknown } });
  for (const event of [
    { type: "job", status: { ...failed, ...unknown }, ...unknown },
    { type: "preview-hit", pylonId, service: "web", at: "2027-01-01T00:00:00Z", login: null, ...unknown },
    { type: "session-event", report: observation.events[0], ...unknown },
  ]) assert.deepEqual(parseProbeEvent(JSON.stringify(event)), event);
});

test("a running pylon's previews from an older probe, which marked each ready, parse without the mark", () => {
  const pylon = {
    pylonId, phase: "running", liveHash: "hash-1", bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image, checkpoint: null }, services: [], listening: [],
    previews: [{ service: "web", httpsPort: 10000 }], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  const older = { ...pylon, previews: [{ service: "web", httpsPort: 10000, ready: true }] };
  assert.deepEqual(parseProbeEvent(JSON.stringify({ type: "pylon", pylon: older })), { type: "pylon", pylon });
  assert.deepEqual(parseProbeEvent(JSON.stringify({ type: "pylon", pylon })), { type: "pylon", pylon });
});

test("the control plane refuses a probe event that fails any check of its fields", () => {
  const snapshot = (o: object) => ({ type: "snapshot", observation: { ...observation, ...o } });
  const bad: unknown[] = [
    null, [], { type: "heartbeat" }, {}, { type: "snapshot" },
    snapshot({ artifacts: null }), snapshot({ jobs: {} }), snapshot({ pylons: undefined }), snapshot({ previewRoutes: {} }), snapshot({ events: null }),
    snapshot({ events: Array.from({ length: 101 }, () => observation.events[0]) }), snapshot({ events: [{ ...observation.events[0], ...unknown }] }),
    snapshot({ jobs: [{ ...running, state: "paused" }] }), snapshot({ jobs: [{ ...failed, code: "gremlins" }] }), snapshot({ jobs: [{ ...running, kind: "" }] }),
    snapshot({ pylons: [{ pylonId, phase: "sleeping" }] }), snapshot({ pylons: [{ phase: "booting" }] }),
    { type: "pylon", pylon: null }, { type: "pylon", pylon: { pylonId: "", phase: "booting" } },
    { type: "job", status: { ...running, jobId: 1 } }, { type: "job", status: { ...failed, code: undefined } },
    { type: "preview-hit", pylonId: "" }, { type: "session-event", report: { sequence: 0, pylon: pylonId, event: { kind: "session.turn-ended" }, time: 2 } },
  ];
  for (const value of bad) assert.throws(() => parseProbeEvent(JSON.stringify(value)), Error, JSON.stringify(value));
  const hundred = parseProbeEvent(JSON.stringify(snapshot({ events: Array.from({ length: 100 }, () => observation.events[0]) })));
  assert.ok(hundred.type === "snapshot" && hundred.observation.events.length === 100);
  assert.ok(parseProbeEvent(JSON.stringify(snapshot({ previewRoutes: null }))).type === "snapshot");
  assert.ok(parseProbeEvent(JSON.stringify(snapshot({ jobs: [{ ...running, code: "gremlins" }] }))).type === "snapshot", "only a failed job's code is checked");
});

const imageManifest = { id: image, gondolinBuildId: "b1", builtOn: "rj-firebat", builtAt: "2027-01-01T00:00:00Z", sha256: hex, pins: {} };
const templateManifest = { id: template, key: { project: "p", image, setupHash: "h" }, commit: "c0ffee", builtAt: "2027-01-01T00:00:00Z", sha256: hex };

test("an artifact manifest is read as it was written, with the fields it does not know", () => {
  for (const manifest of [imageManifest, templateManifest, { ...imageManifest, ...unknown }, { ...templateManifest, key: { ...templateManifest.key, ...unknown } }]) {
    assert.deepEqual(parseArtifactManifest(manifest), manifest);
  }
  const bad: unknown[] = [
    null, [], { ...imageManifest, id: "ckpt-1" }, { ...imageManifest, sha256: hex.toUpperCase() }, { ...imageManifest, builtAt: "" }, { ...imageManifest, gondolinBuildId: undefined },
    { ...imageManifest, builtOn: 1 }, { ...imageManifest, pins: [] }, { ...templateManifest, key: null }, { ...templateManifest, key: { ...templateManifest.key, image: template } },
    { ...templateManifest, key: { ...templateManifest.key, setupHash: "" } }, { ...templateManifest, commit: undefined },
  ];
  for (const value of bad) assert.throws(() => parseArtifactManifest(value), Error, JSON.stringify(value));
});

/** The control plane's client, against a probe that answers every request with `body` and `status`. */
async function stubProbe(t: import("node:test").TestContext) {
  let body = "";
  let status = 200;
  const server = createServer((req, res) => { req.resume().on("end", () => res.writeHead(status, { "content-type": "application/json" }).end(body)); }).listen(0, "127.0.0.1");
  await new Promise((ready) => server.once("listening", ready));
  t.after(() => server.close());
  const client = connectProbe(node as NodeName, "127.0.0.1", "nPROBE" as TailnetNodeId, { port: (server.address() as { port: number }).port, whois: async () => "nPROBE" as TailnetNodeId });
  return { client, answer(value: unknown, answerStatus = 200) { body = JSON.stringify(value); status = answerStatus; } };
}

test("a command result is read as the probe sent it, a close without an outcome as closed, and a result for another command is refused", async (t) => {
  const { client, answer } = await stubProbe(t);
  const at = pylonId as PylonId;
  const send = { outcome: "queued", herdrPane: "w1:p1", resumed: false };
  const results: [PylonCommand, unknown][] = [
    [commands[0]!, { kind: "exec", exitCode: null, output: "", truncated: true, ...unknown }],
    [commands[4]!, { kind: "open-session", herdrPane: "w2:p1", ...unknown }],
    [commands[5]!, { kind: "close-session", outcome: "moved" }],
    [commands[8]!, { kind: "drop-failed-session", dropped: false }],
    [commands[9]!, { kind: "send-claude", ...send, ...unknown }],
    [commands[11]!, { kind: "send-claude-outcome", send: { ...send, ...unknown } }],
    [commands[11]!, { kind: "send-claude-outcome", send: "failed" }],
    [commands[11]!, { kind: "send-claude-outcome", send: "unknown" }],
    [commands[12]!, { kind: "service", services: [], logs: "up" }],
    [commands[14]!, { kind: "link-port", service: "port-65535" }],
    [commands[15]!, { kind: "unlink-port", refused: null }],
    [commands[15]!, { kind: "unlink-port", refused: "web owns it" }],
    ...(["interrupted", "idle", "blocked", "unknown", "not-running"] as const).map((outcome): [PylonCommand, unknown] => [commands[16]!, { kind: "interrupt-claude", outcome, ...unknown }]),
  ];
  for (const [command, result] of results) {
    answer(result);
    assert.deepEqual(await client.command(at, command), result);
  }
  for (const outcome of [undefined, null]) {
    answer({ kind: "close-session", outcome, ...unknown });
    assert.deepEqual(await client.command(at, commands[5]!), { kind: "close-session", outcome: "closed", ...unknown });
  }
  const bad: [PylonCommand, unknown][] = [
    [commands[0]!, { kind: "open-session", herdrPane: "w1:p1" }], [commands[0]!, null], [commands[4]!, { kind: "open-session" }], [commands[5]!, { kind: "close-session", outcome: "gone" }],
    [commands[8]!, { kind: "drop-failed-session" }], [commands[9]!, { kind: "send-claude", ...send, outcome: "lost" }], [commands[9]!, { kind: "send-claude", ...send, herdrPane: "" }],
    [commands[9]!, { kind: "send-claude", ...send, resumed: "no" }], [commands[11]!, { kind: "send-claude-outcome", send: "pending" }], [commands[11]!, { kind: "send-claude-outcome" }],
    [commands[14]!, { kind: "link-port", service: "" }], [commands[15]!, { kind: "unlink-port" }], [commands[15]!, { kind: "unlink-port", refused: "" }],
    [commands[16]!, { kind: "interrupt-claude" }], [commands[16]!, { kind: "interrupt-claude", outcome: "pressed" }],
  ];
  for (const [command, result] of bad) {
    answer(result);
    await assert.rejects(client.command(at, command), Error, JSON.stringify(result));
  }
});

test("a job status is read as the probe sent it, and one that fails a check is refused", async (t) => {
  const { client, answer } = await stubProbe(t);
  for (const status of [running, failed, { ...failed, state: "succeeded", ...unknown }]) {
    answer(status);
    assert.deepEqual(await client.job("job-1" as never), status);
  }
  for (const status of [null, { ...running, subject: "" }, { ...running, state: "paused" }, { ...failed, code: "gremlins" }]) {
    answer(status);
    await assert.rejects(client.job("job-1" as never), Error, JSON.stringify(status));
  }
});

test("a status a method gives no meaning rejects with its status, and with a ProbeError code only for 403 and a command's 409", async (t) => {
  const { client, answer } = await stubProbe(t);
  const at = pylonId as PylonId;
  const rejection = (promise: Promise<unknown>) => promise.then(() => assert.fail("resolved"), (err: unknown) => err);
  answer("no such route", 404);
  const missing = await rejection(client.putPeers([]));
  assert.ok(missing instanceof ProbeHttpError);
  assert.equal(missing.status, 404);
  assert.equal(missing.message, `${node}: PUT /v1/peers: HTTP 404: "no such route"`);
  assert.ok(!("code" in missing), "a plain HTTP error has no code, which callers would read as a ProbeError");
  answer("bad command", 400);
  const invalid = await rejection(client.command(at, commands[0]!));
  assert.ok(invalid instanceof ProbeHttpError && invalid.status === 400 && !("code" in invalid));
  answer("not you", 403);
  const forbidden = await rejection(client.putPeers([]));
  assert.ok(forbidden instanceof ProbeHttpError);
  assert.deepEqual([forbidden.status, forbidden.code, forbidden.message], [403, "forbidden", `${node} refused this caller`]);
  answer("the pylon is stopped", 409);
  const stopped = await rejection(client.command(at, commands[0]!));
  assert.ok(stopped instanceof ProbeHttpError);
  assert.deepEqual([stopped.status, stopped.code, stopped.message], [409, "not-running", `${node}: "the pylon is stopped"`]);
  const conflict = await rejection(client.putPeers([]));
  assert.ok(conflict instanceof ProbeHttpError && !("code" in conflict), "only a command or stream means not-running by 409");
});
