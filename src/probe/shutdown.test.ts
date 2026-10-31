import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PylonId } from "../ids.ts";
import { closeProbe, readShutdownRecord, saveShutdownRecord, shutdownPauseMs, systemState, type DrainOutcome, type ShutdownRecord } from "./shutdown.ts";

/** systemctl as execFile runs it: a nonzero exit rejects, with the stdout on the error. */
const exits = (code: number, stdout: string) => async () => {
  if (code === 0) return { stdout };
  throw Object.assign(new Error(`Command failed: systemctl is-system-running`), { code, stdout, stderr: "" });
};

test("the system is stopping only when systemctl prints stopping, which it does with a nonzero exit", async () => {
  assert.equal(await systemState(exits(1, "stopping\n")), "stopping");
  assert.equal(await systemState(exits(0, "running\n")), "running");
  for (const state of ["degraded", "starting", "maintenance"]) assert.equal(await systemState(exits(1, `${state}\n`)), state);
});

test("a systemctl that cannot answer gives why, which is never stopping", async () => {
  const missing = await systemState(async () => { throw Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" }); });
  assert.equal(missing, "unknown, as systemctl failed: spawn systemctl ENOENT");
  const silent = await systemState(exits(1, ""));
  assert.match(silent, /^unknown, as systemctl failed: Command failed/);
});

test("the shutdown record reads back as it was saved, and as empty when there is none", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-shutdown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "shutdown.json");
  assert.deepEqual(await readShutdownRecord(path), new Map());
  const record: ShutdownRecord = new Map([["pylon-a" as PylonId, {}], ["pylon-b" as PylonId, { failed: "it did not pause within the shutdown's 150 s" }]]);
  await saveShutdownRecord(path, record);
  assert.deepEqual(await readShutdownRecord(path), record);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { pylons: { "pylon-a": {}, "pylon-b": { failed: "it did not pause within the shutdown's 150 s" } } });
});

test("a shutdown record that is not one is refused, naming the file and what is wrong", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-shutdown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "shutdown.json");
  const cases: [string, RegExp][] = [
    ["{", /JSON/],
    [JSON.stringify(["pylon-a"]), /record: /],
    [JSON.stringify({ pylons: { "pylon-a": { failed: 3 } } }), /record\.pylons\.pylon-a\.failed: /],
    [JSON.stringify({ pylons: { "pylon-a": { paused: true } } }), /record\.pylons\.pylon-a: .*paused/],
    [JSON.stringify({ pylons: { "Pylon A": {} } }), /record\.pylons/],
    [JSON.stringify({ pylons: {}, version: 2 }), /record: .*version/],
  ];
  for (const [text, reason] of cases) {
    await writeFile(path, text);
    await assert.rejects(readShutdownRecord(path), (err: Error) => err.message.startsWith(`${path}: `) && reason.test(err.message), text);
  }
});

/** A probe that records what its stop asked of it. */
function probeThat(drain: () => Promise<readonly DrainOutcome[]>) {
  const calls: string[] = [];
  const probe = {
    async drain(withinMs: number) { calls.push(`drain ${withinMs}`); return drain(); },
    async close() { calls.push("close"); },
  };
  return { probe, calls };
}

test("a stop while the system runs, as a deploy's restart, only closes the probe and pauses nothing", async () => {
  for (const state of ["running", "degraded", "unknown, as systemctl failed: spawn systemctl ENOENT"]) {
    const { probe, calls } = probeThat(async () => []);
    const lines: string[] = [];
    await closeProbe(probe, "SIGTERM", (line) => lines.push(line), async () => state);
    assert.deepEqual(calls, ["close"], state);
    assert.deepEqual(lines, [`SIGTERM: the system is ${state}, so closing the probe. Pylon VMs keep running`]);
  }
});

test("a stop while the system is stopping drains within the shutdown's time, logs each pylon, then closes", async () => {
  const { probe, calls } = probeThat(async () => [{ pylonId: "pylon-a" as PylonId, pausedInMs: 412 }, { pylonId: "pylon-b" as PylonId, failed: "it did not pause within the shutdown's 150 s" }]);
  const lines: string[] = [];
  await closeProbe(probe, "SIGTERM", (line) => lines.push(line), async () => "stopping");
  assert.deepEqual(calls, [`drain ${shutdownPauseMs}`, "close"]);
  assert.deepEqual(lines, [
    "SIGTERM: the system is stopping, so pausing every running pylon before closing the probe",
    "pylon-a: paused in 412 ms",
    "pylon-b: not paused: it did not pause within the shutdown's 150 s",
  ]);
});

test("a drain that throws still closes the probe", async () => {
  const { probe, calls } = probeThat(async () => { throw new Error("list failed"); });
  await assert.rejects(closeProbe(probe, "SIGTERM", () => {}, async () => "stopping"), /list failed/);
  assert.deepEqual(calls, [`drain ${shutdownPauseMs}`, "close"]);
});
