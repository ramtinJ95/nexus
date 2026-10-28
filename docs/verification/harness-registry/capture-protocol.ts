// Writes what the probe protocol and the control plane's ingest decide for each session harness: the probe's answer to
// every open-session and close-session body in a matrix of harnesses and fields, the parse of observations whose
// sessions carry each harness, and the registry writes, agent activity included, that ingest makes of them.
// Run from the root of a checkout: node docs/verification/harness-registry/capture-protocol.ts <out-file>
import { writeFile } from "node:fs/promises";
import { json } from "./normalise.ts";

const { parsePylonCommand, parseProbeEvent } = await import("../../../src/protocol.ts");
const { ingest } = await import("../../../src/reconcile.ts");
type PylonObservation = import("../../../src/protocol.ts").PylonObservation;
type PylonId = import("../../../src/protocol.ts").PylonId;
type NodeName = import("../../../src/protocol.ts").NodeName;

const out = process.argv[2]!;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

function command(body: unknown) {
  try {
    return `ok ${json(parsePylonCommand(JSON.stringify(body)))}`;
  } catch (err) {
    return `refused ${(err as Error).message}`;
  }
}

const harnesses = ["claude-code", "pi", "shell"];
const values: Record<string, readonly unknown[]> = {
  resume: ["bd2c2d6b", "", "r".repeat(20_000), 42, null],
  prompt: ["work", "", "p".repeat(16_384), "p".repeat(16_385), 42, null],
  model: ["opus", "", "m".repeat(200), "m".repeat(201), 42, null],
};

log("# parsePylonCommand: open-session, one field at a time");
for (const harness of harnesses) {
  const bare = { kind: "open-session", harness, title: "t" };
  log(`${json(bare)} => ${command(bare)}`);
  for (const [field, options] of Object.entries(values)) {
    for (const value of options) {
      const body = { ...bare, [field]: value };
      log(`${json(body)} => ${command(body)}`);
    }
  }
}

log("");
log("# parsePylonCommand: open-session, fields together");
for (const harness of harnesses) {
  for (const body of [
    { kind: "open-session", harness, title: "t", resume: "bd2c2d6b", prompt: "work", model: "opus" },
    { kind: "open-session", harness, title: "t", prompt: "work", model: "opus" },
    { kind: "open-session", harness, title: "t", resume: "bd2c2d6b", model: "opus" },
    { kind: "open-session", harness, title: "t", extra: true },
    { kind: "open-session", harness },
    { kind: "open-session", harness, title: "" },
  ]) log(`${json(body)} => ${command(body)}`);
}

log("");
log("# parsePylonCommand: open-session with a harness Nexus does not name");
for (const harness of [undefined, "codex", "toString", "constructor", "__proto__", "Claude-Code", "claude", "", null, 42, ["pi"]]) {
  for (const extra of harness === "codex" ? [{}, { model: "opus" }, { resume: "s" }, { prompt: "work" }] : [{}]) {
    const body = { kind: "open-session", ...(harness === undefined ? {} : { harness }), title: "t", ...extra };
    log(`${json(body)} => ${command(body)}`);
  }
}

log("");
log("# parsePylonCommand: close-session");
for (const session of [
  undefined,
  ...harnesses.flatMap((harness) => [
    { harness, harnessSessionId: "s1", title: "review" },
    { harness, harnessSessionId: null, title: null },
    { harness, harnessSessionId: "", title: "review" },
    { harness, title: "review" },
  ]),
  { harness: "codex", harnessSessionId: null, title: null },
  { harness: "toString", harnessSessionId: null, title: null },
  { harnessSessionId: null, title: null },
  { harness: null, harnessSessionId: null, title: null },
  { harness: 42, harnessSessionId: null, title: null },
  null,
]) {
  const body = { kind: "close-session", herdrPane: "w1:p1", ...(session === undefined ? {} : { session }) };
  log(`${json(body)} => ${command(body)}`);
}

const pylonId = "pylon-th-000000000001" as PylonId;
const node = "rj-firebat" as NodeName;
const now = 1_800_000_000_000;
const running = (sessions: readonly unknown[] | null): PylonObservation => ({
  pylonId, phase: "running", liveHash: "lh-0001" as never, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-0123456789ab", checkpoint: null },
  services: [], listening: [], previews: [], sessions: sessions as never, git: null, declaredOutputs: [], attachedClients: 0,
});
const stopped = (sessions: readonly unknown[] | null): PylonObservation => ({ pylonId, phase: "stopped", checkpoint: "ckpt-0001" as never, sessions: sessions as never });
const fact = (harness: string, i: number, extra: Record<string, unknown> = {}) => ({
  id: `w${i}:p1`, state: "running", herdrPane: `w${i}:p1`, harness, harnessSessionId: harness === "shell" ? null : `${harness}-session`, status: "working", title: `${harness} title`, ...extra,
});

function event(frame: unknown) {
  try {
    const parsed = parseProbeEvent(JSON.stringify(frame));
    const pylon = parsed.type === "pylon" ? parsed.pylon : parsed.type === "snapshot" ? parsed.observation.pylons[0]! : null;
    return `ok ${parsed.type}, sessions ${json(pylon !== null && (pylon.phase === "running" || pylon.phase === "stopped") ? pylon.sessions : null)}`;
  } catch (err) {
    return `refused ${(err as Error).message}`;
  }
}

log("");
log("# parseProbeEvent");
const probeEvents: [string, unknown][] = [
  ["a running pylon with a session of each harness", { type: "pylon", pylon: running(harnesses.map((h, i) => fact(h, i + 1))) }],
  ["a running pylon with a failed session of each harness", { type: "pylon", pylon: running(harnesses.map((h, i) => fact(h, i + 1, { state: "failed", herdrPane: null, id: `failed-${i}`, status: "unknown", message: "did not start" }))) }],
  ["a running pylon from before session states, a session of each harness", { type: "pylon", pylon: running(harnesses.map((h, i) => { const { id: _, state: __, ...older } = fact(h, i + 1); return older; })) }],
  ["a running pylon with a codex session", { type: "pylon", pylon: running([fact("codex", 1)]) }],
  ["a running pylon with a session of no harness", { type: "pylon", pylon: running([{ ...fact("pi", 1), harness: undefined }]) }],
  ["a stopped pylon with a paused session of each harness", { type: "pylon", pylon: stopped(harnesses.map((h, i) => ({ id: `w${i + 1}:p1`, herdrPane: `w${i + 1}:p1`, harness: h, harnessSessionId: null, title: h }))) }],
  ["a stopped pylon with a paused codex session", { type: "pylon", pylon: stopped([{ id: "w1:p1", herdrPane: "w1:p1", harness: "codex", harnessSessionId: null, title: "x" }]) }],
  ["a snapshot with a running pylon with a session of each harness", {
    type: "snapshot", observation: {
      node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", events: [], capacity: null, artifacts: [], jobs: [],
      pylons: [running([...harnesses, "codex"].map((h, i) => fact(h, i + 1)))], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [],
    },
  }],
];
for (const [what, frame] of probeEvents) log(`${what} => ${event(frame)}`);

log("");
log("# ingest: one running session, a pylon whose last observation was the same, so only activity is new");
const statuses = ["working", "idle", "blocked", "done", "unknown"];
for (const harness of [...harnesses, "codex"]) {
  for (const state of ["running", "failed"]) {
    for (const status of statuses) {
      const session = fact(harness, 1, state === "failed" ? { state, herdrPane: "w1:p1", status, message: "did not start" } : { status });
      const pylon = running([session]);
      log(`${harness} ${state} ${status} => ${json(ingest({ type: "pylon", pylon }, node, new Map([[pylonId, pylon]]), now))}`);
    }
  }
}

log("");
log("# ingest: activity from several sessions at once");
for (const sessions of [
  [fact("claude-code", 1), fact("pi", 2, { status: "idle" })],
  [fact("claude-code", 1), fact("shell", 2, { status: "idle" })],
  [fact("claude-code", 1, { status: "idle" }), fact("pi", 2)],
  [fact("claude-code", 1), fact("claude-code", 2)],
]) {
  const pylon = running(sessions);
  log(`${sessions.map((s) => `${s.harness}:${s.status}`).join(", ")} => ${json(ingest({ type: "pylon", pylon }, node, new Map([[pylonId, pylon]]), now))}`);
}

log("");
log("# ingest: the session rows written for a new list");
const listed: [string, PylonObservation, PylonObservation | "absent"][] = [
  ["running, a session of each harness, after none", running([...harnesses, "codex"].map((h, i) => fact(h, i + 1, { status: "idle" }))), running([])],
  ["running, a failed session of each harness, after none", running(harnesses.map((h, i) => fact(h, i + 1, { state: "failed", herdrPane: i === 0 ? null : `w${i + 1}:p1`, status: "unknown", message: "did not start" }))), running([])],
  ["stopped, a paused session of each harness, after running", stopped(harnesses.map((h, i) => ({ id: `w${i + 1}:p1`, herdrPane: `w${i + 1}:p1`, harness: h, harnessSessionId: h === "shell" ? null : "s", title: h }))), running([])],
  ["running, a session of each harness, a pylon whose last observation is absent", running(harnesses.map((h, i) => fact(h, i + 1))), "absent"],
];
for (const [what, pylon, previous] of listed) log(`${what} => ${json(ingest({ type: "pylon", pylon }, node, new Map([[pylonId, previous]]), now))}`);

await writeFile(out, lines.join("\n") + "\n");
