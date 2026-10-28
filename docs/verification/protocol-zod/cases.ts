/**
 * The payloads capture.ts feeds every parser: a good payload of each shape, then every mutation of it that
 * `mutations` makes, then the edge cases a mutation cannot reach, such as a limit and the value one past it. It imports
 * nothing from src, so the same cases run against main and the branch.
 */

export type Case = { id: string; value: unknown };

const replacements: [string, unknown][] = [
  ["null", null], ["empty", ""], ["text", "x"], ["zero", 0], ["negative", -1], ["fraction", 1.5], ["true", true], ["array", []], ["object", {}],
];

/**
 * The seed, then for every field at every depth: the field removed, the field replaced by each of `replacements`, and
 * an unknown field beside it. Array elements are replaced but not removed.
 */
export function mutations(name: string, seed: unknown): Case[] {
  const cases: Case[] = [{ id: name, value: seed }];
  const visit = (path: (string | number)[], value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    const at = path.length === 0 ? "(root)" : path.join(".");
    if (!Array.isArray(value)) cases.push({ id: `${name} ${at} +unknown`, value: set(seed, [...path, "zzUnknown"], { from: "a newer peer" }) });
    for (const key of Array.isArray(value) ? value.keys() : Object.keys(value)) {
      const field = [...path, key];
      if (!Array.isArray(value)) cases.push({ id: `${name} ${field.join(".")} removed`, value: set(seed, field, removed) });
      for (const [label, replacement] of replacements) cases.push({ id: `${name} ${field.join(".")}=${label}`, value: set(seed, field, replacement) });
      visit(field, (value as Record<string | number, unknown>)[key]);
    }
  };
  visit([], seed);
  for (const [label, replacement] of replacements) cases.push({ id: `${name} (root)=${label}`, value: replacement });
  return cases;
}

const removed = Symbol("removed");

/** A copy of `value` with the field at `path` set, or deleted for `removed`. */
export function set(value: unknown, path: readonly (string | number)[], to: unknown): unknown {
  if (path.length === 0) return to;
  const [key, ...rest] = path;
  const copy: Record<string | number, unknown> = Array.isArray(value) ? [...value] : { ...(value as object) };
  if (rest.length === 0 && to === removed) delete copy[key!];
  else copy[key!] = set(copy[key!], rest, to);
  return copy;
}

const pylonId = "pylon-th-1";
const image = "img-abc123";
const template = "tpl-def456";
const hex = "ab".repeat(32);
const boot = (source: unknown, repo: unknown) => ({
  pylonId, image, source, repo,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 20 },
  network: { allowedHosts: ["github.com"], secrets: [] },
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
});
const live = { previews: [{ service: "web", port: 5173, httpsPort: 8443 }], overlay: [{ path: "/home/user/.nexus/pylon.json", mode: 420, owner: "user", content: "{}" }] };
const clone = { kind: "clone", url: "https://github.com/acme/app.git", checkout: { branch: "main", commit: "c0ffee" } };

export const jobs: Record<string, unknown> = {
  "spawn-fresh-clone": { kind: "spawn", pylonId, boot: boot({ kind: "fresh", preSetup: null }, clone), live, liveHash: "hash-1" },
  "spawn-fresh-presetup": { kind: "spawn", pylonId, boot: boot({ kind: "fresh", preSetup: "apt-get install -y jq" }, { kind: "empty", branch: "main" }), live, liveHash: "hash-1", relaunch: false },
  "spawn-template": { kind: "spawn", pylonId, boot: boot({ kind: "template", template }, clone), live, liveHash: "hash-1" },
  "spawn-resume": { kind: "spawn", pylonId, boot: boot({ kind: "resume", checkpoint: "ckpt-1" }, { kind: "empty", branch: "main" }), live, liveHash: "hash-1" },
  pause: { kind: "pause", pylonId, checkpoint: "ckpt-abc" },
  delete: { kind: "delete", pylonId },
  "build-image": { kind: "build-image", image, recipe: { pins: { node: "24" } } },
  "build-template": { kind: "build-template", template, inputs: { project: "p", image, setupHash: "h" } },
  "fetch-image": { kind: "fetch-artifact", artifact: image, from: "rj-firebat", sha256: hex },
  "fetch-template": { kind: "fetch-artifact", artifact: template, from: "rj-firebat", sha256: hex },
  "fetch-checkpoint": { kind: "fetch-artifact", artifact: "ckpt-abc", from: "rj-firebat", sha256: hex },
  "drop-image": { kind: "drop-artifact", artifact: image },
  "drop-template": { kind: "drop-artifact", artifact: template },
};

export const node = "test-node";
export const jobId = "job-1";
export const envelope = (job: unknown) => ({ jobId, node, issuedAt: "2020-01-01T00:00:00.000Z", notAfter: "2020-01-01T00:00:30.000Z", job });

export function envelopeCases(): Case[] {
  const cases = Object.entries(jobs).flatMap(([name, job]) => mutations(`envelope ${name}`, envelope(job)));
  const spawn = jobs["spawn-fresh-clone"] as Record<string, unknown>;
  const edge: [string, unknown][] = [
    ["spawn boot.pylonId differs", set(spawn, ["boot", "pylonId"], "pylon-other")],
    ["spawn repo.kind fork", set(spawn, ["boot", "repo", "kind"], "fork")],
    ["spawn source.kind snapshot", set(spawn, ["boot", "source", "kind"], "snapshot")],
    ["spawn template source without template", set(jobs["spawn-template"], ["boot", "source", "template"], "img-abc")],
    ["spawn fresh source without preSetup", set(spawn, ["boot", "source", "preSetup"], removed)],
    ["spawn resume source with preSetup", set(jobs["spawn-resume"], ["boot", "source", "preSetup"], 3)],
    ["spawn template source with preSetup", set(jobs["spawn-template"], ["boot", "source", "preSetup"], 3)],
    ["spawn relaunch undefined-like null", set(spawn, ["relaunch"], null)],
    ["spawn image with capitals", set(spawn, ["boot", "image"], "img-ABC")],
    ["spawn image 41 chars", set(spawn, ["boot", "image"], `img-${"a".repeat(41)}`)],
    ["spawn image 40 chars", set(spawn, ["boot", "image"], `img-${"a".repeat(40)}`)],
    ["pause checkpoint without prefix", set(jobs.pause, ["checkpoint"], "abc")],
    ["pause checkpoint bare prefix", set(jobs.pause, ["checkpoint"], "ckpt-")],
    ["build-image template ID", set(jobs["build-image"], ["image"], template)],
    ["build-template image ID", set(jobs["build-template"], ["template"], image)],
    ["fetch sha256 uppercase", set(jobs["fetch-image"], ["sha256"], hex.toUpperCase())],
    ["fetch sha256 short", set(jobs["fetch-image"], ["sha256"], hex.slice(1))],
    ["fetch artifact pylon", set(jobs["fetch-image"], ["artifact"], pylonId)],
    ["drop checkpoint", set(jobs["drop-image"], ["artifact"], "ckpt-abc")],
    ["kind unknown", { kind: "migrate", pylonId }],
    ["kind missing", { pylonId }],
  ];
  for (const [name, job] of edge) cases.push({ id: `envelope edge ${name}`, value: envelope(job) });
  cases.push({ id: "envelope edge issuedAt not a time", value: { ...envelope(jobs.delete), issuedAt: "yesterday" } });
  cases.push({ id: "envelope edge notAfter not a time", value: { ...envelope(jobs.delete), notAfter: "soon" } });
  cases.push({ id: "envelope edge issuedAt a date only", value: { ...envelope(jobs.delete), issuedAt: "2020-01-01" } });
  return cases;
}

export const commands: Record<string, unknown> = {
  exec: { kind: "exec", argv: ["git", "status"], cwd: "/home/user/workspace/repo", timeoutMs: 10_000 },
  "open-claude": { kind: "open-session", harness: "claude-code", title: "review", resume: "s-1", prompt: "Look at the diff", model: "opus" },
  "open-pi": { kind: "open-session", harness: "pi", title: "plan", resume: "/home/user/.pi/s.jsonl" },
  "open-shell": { kind: "open-session", harness: "shell", title: "sh" },
  "close-bare": { kind: "close-session", herdrPane: "w1:p1" },
  "close-named": { kind: "close-session", herdrPane: "w1:p1", session: { harness: "claude-code", harnessSessionId: "s-1", title: "review" } },
  "close-named-nulls": { kind: "close-session", herdrPane: "w1:p1", session: { harness: "shell", harnessSessionId: null, title: null } },
  "drop-failed": { kind: "drop-failed-session", id: "failed-0123456789ab" },
  "send-claude": { kind: "send-claude", session: "0b1c-2d3e", text: "Fix it\nplease", model: "opus", requestId: "r-1" },
  "send-claude-bare": { kind: "send-claude", session: "0b1c-2d3e", text: "hi" },
  "send-outcome": { kind: "send-claude-outcome", requestId: "r-1" },
  "service-logs": { kind: "service", op: "logs", name: "web", lines: 200 },
  "service-ensure": { kind: "service", op: "ensure" },
  "link-port": { kind: "link-port", port: 5173 },
  "unlink-port": { kind: "unlink-port", port: 5173 },
};

export function commandCases(): Case[] {
  const cases = Object.entries(commands).flatMap(([name, command]) => mutations(`command ${name}`, command));
  const edge: [string, unknown][] = [
    ["exec empty argv", set(commands.exec, ["argv"], [])],
    ["exec argv with a number", set(commands.exec, ["argv"], ["ls", 1])],
    ["exec relative cwd", set(commands.exec, ["cwd"], "workspace")],
    ["exec timeout 60000", set(commands.exec, ["timeoutMs"], 60_000)],
    ["exec timeout 60001", set(commands.exec, ["timeoutMs"], 60_001)],
    ["exec timeout 1", set(commands.exec, ["timeoutMs"], 1)],
    ["exec timeout as text", set(commands.exec, ["timeoutMs"], "100")],
    ["open harness codex", set(commands["open-shell"], ["harness"], "codex")],
    ["open pi with a model", set(commands["open-pi"], ["model"], "gpt")],
    ["open pi with a prompt", set(commands["open-pi"], ["prompt"], "hi")],
    ["open shell with resume", set(commands["open-shell"], ["resume"], "s-1")],
    ["open claude model 200", set(commands["open-claude"], ["model"], "m".repeat(200))],
    ["open claude model 201", set(commands["open-claude"], ["model"], "m".repeat(201))],
    ["open claude prompt 16384", set(commands["open-claude"], ["prompt"], "p".repeat(16_384))],
    ["open claude prompt 16385", set(commands["open-claude"], ["prompt"], "p".repeat(16_385))],
    ["open claude prompt with control character", set(commands["open-claude"], ["prompt"], "a\u0007b")],
    ["close harness codex", set(commands["close-named"], ["session", "harness"], "codex")],
    ["send session with a slash", set(commands["send-claude"], ["session"], "a/b")],
    ["send session 200", set(commands["send-claude"], ["session"], "s".repeat(200))],
    ["send session 201", set(commands["send-claude"], ["session"], "s".repeat(201))],
    ["send text 16384", set(commands["send-claude"], ["text"], "t".repeat(16_384))],
    ["send text 16385", set(commands["send-claude"], ["text"], "t".repeat(16_385))],
    ["send text with escape", set(commands["send-claude"], ["text"], "a\u001b[31mb")],
    ["send text with tab", set(commands["send-claude"], ["text"], "a\tb")],
    ["send text with carriage return", set(commands["send-claude"], ["text"], "a\r\nb")],
    ["send text whitespace only", set(commands["send-claude"], ["text"], " \n ")],
    ["send model 201", set(commands["send-claude"], ["model"], "m".repeat(201))],
    ["service op start", set(commands["service-ensure"], ["op"], "start")],
    ["service lines 1", set(commands["service-logs"], ["lines"], 1)],
    ["link port 65535", set(commands["link-port"], ["port"], 65_535)],
    ["link port 65536", set(commands["link-port"], ["port"], 65_536)],
    ["link port 7480", set(commands["link-port"], ["port"], 7480)],
    ["unlink port 22", set(commands["unlink-port"], ["port"], 22)],
    ["kind unknown", { kind: "reboot" }],
  ];
  for (const [name, command] of edge) cases.push({ id: `command edge ${name}`, value: command });
  return cases;
}

export function streamCases(): { id: string; path: string; upgrade: string | undefined }[] {
  const at = `/v1/pylons/${pylonId}/stream`;
  const query = (request: unknown) => `${at}?request=${encodeURIComponent(JSON.stringify(request))}`;
  return [
    ...mutations("stream", { argv: ["pi-env", "serve"] }).map((c) => ({ id: c.id, path: query(c.value), upgrade: "nexus-stream" })),
    ...mutations("stream with pty", { argv: ["sh"], pty: null }).map((c) => ({ id: c.id, path: query(c.value), upgrade: "nexus-stream" })),
    { id: "stream no request", path: at, upgrade: "nexus-stream" },
    { id: "stream request not JSON", path: `${at}?request=%7Bargv`, upgrade: "nexus-stream" },
    { id: "stream other protocol", path: query({ argv: ["sh"] }), upgrade: "websocket" },
    { id: "stream upgrade in capitals", path: query({ argv: ["sh"] }), upgrade: "Nexus-Stream" },
    { id: "stream other path", path: `/v1/pylons/${pylonId}/streams?request=${encodeURIComponent(JSON.stringify({ argv: ["sh"] }))}`, upgrade: "nexus-stream" },
    { id: "stream encoded pylon", path: `/v1/pylons/pylon%2Dth%2D1/stream?request=${encodeURIComponent(JSON.stringify({ argv: ["sh"] }))}`, upgrade: "nexus-stream" },
  ];
}

const running = {
  pylonId, phase: "running", liveHash: "hash-1", bootedAt: "2026-10-27T11:00:00Z", bootedFrom: { image, checkpoint: null },
  services: [{ name: "web", state: "ready", port: 5173, declared: true, wantsPreview: true }],
  listening: [{ port: 5173 }],
  previews: [{ service: "web", httpsPort: 8443, ready: true }],
  sessions: [
    { id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s-1", status: "working", title: "review" },
    { id: "failed-0123456789ab", state: "failed", herdrPane: null, harness: "pi", harnessSessionId: null, status: "unknown", title: "plan", message: "pi did not start" },
  ],
  git: { head: "c0ffee", branch: "main", dirty: false, branches: [] },
  declaredOutputs: [],
  attachedClients: 1,
};
export const pylons: Record<string, unknown> = {
  running,
  "running-older": { ...set(running, ["listening"], removed) as object, sessions: [{ herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, status: "idle" }] },
  stopped: { pylonId, phase: "stopped", checkpoint: "ckpt-1", sessions: [{ id: "w1:p1", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, title: "sh" }] },
  "stopped-older": { pylonId, phase: "stopped", checkpoint: null },
  broken: { pylonId, phase: "broken", detail: "Setup exited 1", cause: "setup" },
  "broken-older": { pylonId, phase: "broken", detail: "Setup exited 1" },
  "broken-newer": { pylonId, phase: "broken", detail: "Setup exited 1", cause: "cosmic-ray" },
  booting: { pylonId, phase: "booting" },
};

export const statuses: Record<string, unknown> = {
  running: { jobId, subject: pylonId, kind: "spawn", state: "running", startedAt: "2026-10-27T11:00:00Z" },
  succeeded: { jobId, subject: pylonId, kind: "pause", state: "succeeded", finishedAt: "2026-10-27T11:00:00Z" },
  failed: { jobId, subject: image, kind: "build-image", state: "failed", finishedAt: "2026-10-27T11:00:00Z", code: "setup-failed", message: "exit 1", logTail: "..." },
};

const report = { sequence: 3, pylon: pylonId, event: { kind: "session.turn-ended", at: 1, session: "s-1", message: "done", id: "e-1" }, time: 2 };
const observation = {
  events: [report], node, observedAt: "2026-10-27T12:00:00Z", probeBootId: "boot-1",
  capacity: { cpus: 8, committedCpus: 2, memoryGiB: 32, committedMemoryGiB: 4, diskFreeGiB: 100, committedDiskGiB: 20 },
  artifacts: [image, "ckpt-1"],
  jobs: [statuses.running, statuses.failed],
  pylons: [running, pylons.stopped, pylons.broken],
  previewRoutes: [{ httpsPort: 8443, pylonId, service: "web" }],
  grants: { secrets: ["GH_TOKEN"], gitSsh: true },
  spawnsWithoutRelaunch: true,
  heldSecrets: ["NEXUS_CHATGPT_TOKEN"],
};
const oldest = { node, observedAt: "2026-10-27T12:00:00Z", probeBootId: "boot-1", capacity: { memoryGiB: 32, committedMemoryGiB: 0, diskFreeGiB: 100 }, artifacts: [], jobs: [], pylons: [pylons["running-older"], pylons["broken-older"]] };

export function eventCases(): Case[] {
  const events: Record<string, unknown> = {
    snapshot: { type: "snapshot", observation },
    "snapshot-oldest": { type: "snapshot", observation: oldest },
    "session-event": { type: "session-event", report },
    job: { type: "job", status: statuses.failed },
    "preview-hit": { type: "preview-hit", pylonId, service: "web", at: "2026-10-27T12:00:00Z", login: "rj@example.com" },
    ...Object.fromEntries(Object.entries(pylons).map(([name, pylon]) => [`pylon-${name}`, { type: "pylon", pylon }])),
  };
  const cases = Object.entries(events).flatMap(([name, event]) => mutations(`event ${name}`, event));
  const edge: [string, unknown][] = [
    ["101 events", set(events.snapshot, ["observation", "events"], Array.from({ length: 101 }, () => report))],
    ["100 events", set(events.snapshot, ["observation", "events"], Array.from({ length: 100 }, () => report))],
    ["null routes", set(events.snapshot, ["observation", "previewRoutes"], null)],
    ["job state paused", set(events.job, ["status", "state"], "paused")],
    ["job code unknown", set(events.job, ["status", "code"], "gremlins")],
    ["job code on a running job", set(set(events.job, ["status", "state"], "running"), ["status", "code"], "gremlins")],
    ["pylon phase sleeping", set(events["pylon-booting"], ["pylon", "phase"], "sleeping")],
    ["job code toString", set(events.job, ["status", "code"], "toString")],
    ["job code constructor", set(events.job, ["status", "code"], "constructor")],
    ["type unknown", { type: "heartbeat" }],
  ];
  for (const [name, event] of edge) cases.push({ id: `event edge ${name}`, value: event });
  return cases;
}

export function submitReplyCases(): { id: string; status: number; value: unknown }[] {
  const replies: [string, number, unknown][] = [
    ["accepted", 200, { accepted: statuses.running }],
    ["busy", 409, { rejected: "busy", inFlight: "job-0" }],
    ["expired", 410, { rejected: "expired" }],
    ["invalid", 400, { rejected: "invalid", message: "job.kind is wrong" }],
  ];
  const cases = replies.flatMap(([name, status, value]) => mutations(`reply ${name}`, value).map((c) => ({ ...c, status })));
  for (const [name, , value] of replies) for (const status of [200, 400, 409, 410, 500]) cases.push({ id: `reply edge ${name} as ${status}`, status, value });
  return cases;
}

export const results: Record<string, [unknown, unknown]> = {
  exec: [commands.exec, { kind: "exec", exitCode: 0, output: "clean", truncated: false }],
  "open-session": [commands["open-shell"], { kind: "open-session", herdrPane: "w2:p1" }],
  "close-session": [commands["close-bare"], { kind: "close-session", outcome: "moved" }],
  "close-session-older": [commands["close-bare"], { kind: "close-session" }],
  "drop-failed-session": [commands["drop-failed"], { kind: "drop-failed-session", dropped: true }],
  "send-claude": [commands["send-claude"], { kind: "send-claude", outcome: "queued", herdrPane: "w1:p1", resumed: false }],
  "send-outcome-sent": [commands["send-outcome"], { kind: "send-claude-outcome", send: { outcome: "sent", herdrPane: "w1:p1", resumed: true } }],
  "send-outcome-failed": [commands["send-outcome"], { kind: "send-claude-outcome", send: "failed" }],
  service: [commands["service-logs"], { kind: "service", services: [{ name: "web", state: "ready", port: 5173, declared: true, wantsPreview: true }], logs: "up" }],
  "link-port": [commands["link-port"], { kind: "link-port", service: "port-5173" }],
  "unlink-port": [commands["unlink-port"], { kind: "unlink-port", refused: null }],
  "unlink-port-refused": [commands["unlink-port"], { kind: "unlink-port", refused: "web owns it" }],
};

export function resultCases(): { id: string; command: unknown; value: unknown }[] {
  const cases = Object.entries(results).flatMap(([name, [command, result]]) => mutations(`result ${name}`, result).map((c) => ({ ...c, command })));
  cases.push({ id: "result edge close-session null outcome", command: commands["close-bare"], value: { kind: "close-session", outcome: null } });
  cases.push({ id: "result edge send-outcome unknown", command: commands["send-outcome"], value: { kind: "send-claude-outcome", send: "unknown" } });
  cases.push({ id: "result edge kind mismatch", command: commands.exec, value: results["open-session"]![1] });
  return cases;
}

export function statusCases(): Case[] {
  const cases = Object.entries(statuses).flatMap(([name, status]) => mutations(`status ${name}`, status));
  cases.push({ id: "status edge code toString", value: set(statuses.failed, ["code"], "toString") });
  return cases;
}

export const manifests: Record<string, unknown> = {
  image: { id: image, gondolinBuildId: "b1", builtOn: "rj-firebat", builtAt: "2026-10-27T00:00:00Z", sha256: hex, pins: { node: "24" } },
  template: { id: template, key: { project: "p", image, setupHash: "h" }, commit: "c0ffee", builtAt: "2026-10-27T00:00:00Z", sha256: hex },
};

export function manifestCases(): Case[] {
  const cases = Object.entries(manifests).flatMap(([name, manifest]) => mutations(`manifest ${name}`, manifest));
  cases.push({ id: "manifest edge checkpoint", value: { ...manifests.template as object, id: "ckpt-1" } });
  cases.push({ id: "manifest edge template key image is a template", value: set(manifests.template, ["key", "image"], template) });
  return cases;
}

export const sessionsFile = {
  version: 1, recordedAt: "2026-10-27T12:00:00Z",
  sessions: [
    { herdrPane: "w1:p1", harness: "claude-code", title: "review", cwd: "/home/user/workspace/repo", harnessSessionId: "s-1", model: "opus" },
    { herdrPane: "w2:p1", harness: "shell", title: "sh", cwd: "/home/user", harnessSessionId: null },
  ],
  failed: [
    { record: { herdrPane: "w3:p1", harness: "pi", title: "plan", cwd: "/home/user", harnessSessionId: "/home/user/.pi/s.jsonl" }, inPane: false, message: "pi did not start" },
    { record: { herdrPane: "w4:p1", harness: "claude-code", title: "fix", cwd: "/home/user", harnessSessionId: null }, inPane: true, message: "Claude did not start" },
  ],
};

export function sessionsFileCases(): Case[] {
  const cases = mutations("sessions-file", sessionsFile);
  cases.push({ id: "sessions-file edge version 2", value: { ...sessionsFile, version: 2 } });
  cases.push({ id: "sessions-file edge harness codex", value: set(sessionsFile, ["sessions", 1, "harness"], "codex") });
  cases.push({ id: "sessions-file edge harness toString", value: set(sessionsFile, ["sessions", 1, "harness"], "toString") });
  cases.push({ id: "sessions-file edge harness constructor", value: set(sessionsFile, ["sessions", 1, "harness"], "constructor") });
  return cases;
}

const pane = (id: string, workspace: string, agent: string | null, status: string, session: unknown) => ({
  pane_id: id, workspace_id: workspace, tab_id: `${workspace}:t1`, agent, agent_status: status, cwd: "/home/user", foreground_cwd: "/home/user/workspace/repo", agent_session: session,
});
export const herdrSnapshot = {
  snapshot: {
    workspaces: [{ workspace_id: "w1", label: "review" }, { workspace_id: "w2", label: "sh" }, { workspace_id: "w3", label: "other agent" }],
    panes: [
      pane("w1:p1", "w1", "claude", "working", { agent: "claude", kind: "id", value: "s-1" }),
      pane("w2:p1", "w2", null, "unknown", null),
      pane("w3:p1", "w3", "codex", "idle", { agent: "codex", kind: "id", value: "c-1" }),
    ],
  },
};

export function herdrSnapshotCases(): Case[] {
  const cases = mutations("herdr-snapshot", herdrSnapshot);
  cases.push({ id: "herdr-snapshot edge pane in no listed workspace", value: set(herdrSnapshot, ["snapshot", "panes", 1, "workspace_id"], "w9") });
  cases.push({ id: "herdr-snapshot edge session of another agent", value: set(herdrSnapshot, ["snapshot", "panes", 0, "agent_session", "agent"], "pi") });
  cases.push({ id: "herdr-snapshot edge no cwds", value: set(set(herdrSnapshot, ["snapshot", "panes", 1, "cwd"], null), ["snapshot", "panes", 1, "foreground_cwd"], null) });
  return cases;
}

export const herdrReplies: Record<string, unknown> = {
  "workspace-create": { id: "cli:1", result: { workspace: { workspace_id: "w5" }, root_pane: { pane_id: "w5:p1" } } },
  "process-info": { id: "cli:1", result: { process_info: { shell_pid: 42, foreground_processes: [{ argv: ["claude", "--model", "opus", "--session-id", "s-9"] }, { argv0: "node", name: "pi" }] } } },
  error: { id: "cli:1", error: { code: "pane_not_found", message: "no pane w9:p1" } },
};

export function herdrReplyCases(): Case[] {
  return Object.entries(herdrReplies).flatMap(([name, reply]) => mutations(`herdr-reply ${name}`, reply));
}
