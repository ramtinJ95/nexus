import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "./control/registry.ts";
import { eventCursor, pylonEventSchema } from "./events.ts";

test("a follower reconnects across a registry restart without missing events", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-events-"));
  const path = join(dir, "registry.sqlite");
  let registry = openRegistry(path);
  try {
    const first = registry.appendEvent("release.changed", null, { state: "installing" });
    assert.deepEqual(registry.events().map((e) => e.id), [first.id]);
    registry.close();
    registry = openRegistry(path);
    const second = registry.appendEvent("release.changed", null, { state: "healthy" });
    const third = registry.appendEvent("release.changed", null, { state: "pending" });
    assert.deepEqual(registry.events(first.id).map((e) => e.id), [second.id, third.id]);
    assert.deepEqual(registry.events(third.id), []);
    assert.deepEqual(registry.events("0", { kinds: ["session.turn-ended"] }), []);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pylon event input rejects other threads, unknown kinds and oversized payloads", () => {
  for (const input of [
    { kind: "session.turn-ended", thread: "another-thread" },
    { kind: "release.changed" },
    { kind: "unknown" },
    { kind: "session.turn-started", at: -1 },
    { kind: "session.turn-started", at: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "session.waiting", message: "x".repeat(2049) },
    { kind: "session.ended", session: "x".repeat(201) },
  ]) assert.equal(pylonEventSchema.safeParse(input).success, false);
  assert.equal(pylonEventSchema.safeParse({ kind: "session.turn-started", session: "abc" }).success, true);
  for (const cursor of ["-1", "1.2", "01", "9007199254740992"]) assert.throws(() => eventCursor(cursor));
});

test("bounded retention reports an expired cursor instead of silently skipping", () => {
  const registry = openRegistry(":memory:");
  try {
    for (let i = 0; i < 10_002; i++) registry.appendEvent("release.changed", null, {});
    assert.equal(registry.events().length, 10_000);
    assert.throws(() => registry.events("1"), /expired/);
    assert.equal(registry.events("2").length, 10_000);
  } finally { registry.close(); }
});

test("the probe journal survives restart and preserves bounded ordered replay", async () => {
  const { eventJournal } = await import("./probe/event-journal.ts");
  const dir = mkdtempSync(join(tmpdir(), "nexus-journal-"));
  const path = join(dir, "events.sqlite");
  let journal = eventJournal(path);
  try {
    const first = journal.append("pylon-t1" as import("./protocol.ts").PylonId, { kind: "session.turn-started", session: "c1" });
    journal.close();
    journal = eventJournal(path);
    assert.deepEqual(journal.recent(), [first]);
    for (let i = 0; i < 101; i++) journal.append(first.pylon, { kind: "session.turn-ended", session: "c1" });
    assert.equal(journal.recent().length, 100);
    assert.equal(journal.recent()[0]!.sequence, 3);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("parallel tool hooks share a throttled heartbeat, and refresh after five minutes", async () => {
  const { heartbeatDue, heartbeatIntervalMs } = await import("../images/pylon/nexus-heartbeat.ts");
  const dir = mkdtempSync(join(tmpdir(), "nexus-heartbeat-"));
  const path = join(dir, "session");
  try {
    const now = Date.now();
    const replies = await Promise.all(Array.from({ length: 20 }, () => heartbeatDue(path, now)));
    assert.equal(replies.filter(Boolean).length, 1);
    assert.equal(await heartbeatDue(path, now + heartbeatIntervalMs - 1), false);
    assert.equal(await heartbeatDue(path, now + heartbeatIntervalMs), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a turn end with background tasks still running reports a heartbeat, and names the shells it waits for alone", async () => {
  const { reportedKind } = await import("../images/pylon/nexus-heartbeat.ts");
  const subagent = { id: "ac4719df54252d254", type: "subagent", status: "running", agent_type: "general-purpose" };
  const shell = { id: "bq5q9o836", type: "shell", status: "running", command: "sleep 90" };
  assert.deepEqual(reportedKind("session.turn-ended", { background_tasks: [shell, subagent] }), { kind: "session.heartbeat" });
  assert.deepEqual(reportedKind("session.turn-ended", { background_tasks: [shell] }), { kind: "session.heartbeat", shells: ["bq5q9o836"] });
  assert.deepEqual(reportedKind("session.turn-ended", { background_tasks: [{ ...subagent, status: "completed" }, { ...shell, status: "completed" }] }), { kind: "session.turn-ended" });
  assert.deepEqual(reportedKind("session.turn-ended", { background_tasks: [] }), { kind: "session.turn-ended" });
  assert.deepEqual(reportedKind("session.turn-ended", {}), { kind: "session.turn-ended" }, "a Claude without the field ends turns as before");
  assert.deepEqual(reportedKind("session.ended", { background_tasks: [subagent, shell] }), { kind: "session.ended" });
});

test("a held turn end heartbeats every five minutes while the command runs, and ends the turn after it exits or waits at the cap", async () => {
  const { backgroundShellCapMs, backgroundStillRunning, holdTurnEnd } = await import("../images/pylon/nexus-heartbeat.ts");
  const run = async (exitsAfterMs: number, supersededAfterMs = Infinity) => {
    let now = 0;
    const reports: [string, number, string?][] = [];
    await holdTurnEnd({
      running: async () => now < exitsAfterMs,
      superseded: async () => now >= supersededAfterMs,
      report: async (kind, message) => { reports.push(message === undefined ? [kind, now / 60_000] : [kind, now / 60_000, message]); },
    }, { now: () => now, sleep: async (ms) => { now += ms; } });
    return reports;
  };
  assert.deepEqual(await run(12 * 60_000), [["session.heartbeat", 5], ["session.heartbeat", 10], ["session.turn-ended", 12.5]]);
  const capped = await run(Infinity);
  assert.equal(capped.filter(([kind]) => kind === "session.heartbeat").length, backgroundShellCapMs / (5 * 60_000));
  assert.deepEqual(capped.slice(-2), [["session.turn-ended", 120, backgroundStillRunning], ["session.waiting", 120, backgroundStillRunning]]);
  assert.deepEqual(await run(Infinity, 7 * 60_000), [["session.heartbeat", 5]], "a newer Stop's hold takes over and this one stops");
  assert.deepEqual(await run(3 * 60_000, 3.2 * 60_000), [], "a hold superseded while it settles sends no turn end");
});

test("at the cap the waiting report is sent only after the turn end's sender finishes, so the turn end cannot clear it", async () => {
  const { holdTurnEnd } = await import("../images/pylon/nexus-heartbeat.ts");
  let now = 0;
  const log: string[] = [];
  await holdTurnEnd({
    running: async () => true,
    superseded: async () => false,
    report: async (kind) => {
      if (kind === "session.heartbeat") return;
      log.push(`${kind} sent`);
      await new Promise((resolve) => setTimeout(resolve, kind === "session.turn-ended" ? 50 : 0));
      log.push(`${kind} accepted`);
    },
  }, { now: () => now, sleep: async (ms) => { now += ms; } });
  assert.deepEqual(log, ["session.turn-ended sent", "session.turn-ended accepted", "session.waiting sent", "session.waiting accepted"]);
});

test("the newest Stop's hold owns the session whatever order the holds start in, and only its owner releases it", async (t) => {
  const { claimHold, holdSuperseded, releaseHold } = await import("../images/pylon/nexus-heartbeat.ts");
  const dir = mkdtempSync(join(tmpdir(), "nexus-hold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = join(dir, "session");
  assert.equal(await claimHold(owner, 2000, 22), true, "the newer Stop's hold starts first");
  assert.equal(await claimHold(owner, 1000, 11), false, "the older one, starting later, finds a newer owner and exits");
  assert.equal(await holdSuperseded(owner, 2000, 22), false);
  await releaseHold(owner, 1000, 11);
  assert.equal(await holdSuperseded(owner, 2000, 22), false, "a hold that never owned the session cannot release it");
  assert.equal(await claimHold(owner, 3000, 33), true);
  assert.equal(await holdSuperseded(owner, 2000, 22), true);
  await releaseHold(owner, 2000, 22);
  assert.equal(await holdSuperseded(owner, 3000, 33), false, "a superseded hold's release leaves the new owner");
  const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => claimHold(join(dir, "race"), 100 + i, 1000 + i)));
  assert.equal(await holdSuperseded(join(dir, "race"), 119, 1019), false, "concurrent claims leave the newest Stop's hold as owner");
  assert.equal(claims[19], true);
  await releaseHold(owner, 3000, 33);
  assert.equal(await holdSuperseded(owner, 3000, 33), true, "the owner's release frees the session");
});

test("a group counts only while its leader is the one recorded, or, without a leader, while a member of that generation lives", async (t) => {
  const { backgroundWatch } = await import("../images/pylon/nexus-heartbeat.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const proc = mkdtempSync(join(tmpdir(), "nexus-proc-"));
  t.after(() => rmSync(proc, { recursive: true, force: true }));
  const processes = (list: [pid: number, ppid: number, pgid: number, start: number][]) => {
    rmSync(proc, { recursive: true, force: true });
    mkdirSync(proc);
    for (const [pid, ppid, pgid, start] of list) {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      const rest = Array.from({ length: 13 }, () => "0").join(" ");
      writeFileSync(join(proc, String(pid), "stat"), `${pid} (python3) S ${ppid} ${pgid} ${pgid} 0 -1 ${rest} ${start} 0`);
    }
  };
  const build = { pgid: 4200, start: 5_000 };
  const hold = 5_050;
  const watch = (since = hold) => backgroundWatch("c1", [], [build], { proc, since });

  const running = watch();
  processes([[4200, 100, 4200, 5_000], [4201, 4200, 4200, 5_010]]);
  assert.equal(await running(), true);
  processes([[4201, 1, 4200, 5_010], [4202, 4201, 4200, 6_000]]);
  assert.equal(await running(), true, "a member outlives its leader");
  processes([[4202, 1, 4200, 6_000]]);
  assert.equal(await running(), true, "a member forked after the hold started, while the group was known to be the original");
  processes([]);
  assert.equal(await running(), false);
  processes([[4300, 4200, 4200, 9_100]]);
  assert.equal(await running(), false, "the ID reused by a leader that forked and exited before the poll");

  processes([[4201, 1, 4200, 5_010]]);
  assert.equal(await watch()(), true, "a member that started before the hold, with its leader gone by the first poll");
  processes([[4300, 4200, 4200, 9_100]]);
  assert.equal(await watch()(), false, "a reused ID's member, the first time the hold looks");
  processes([[4200, 100, 4200, 9_000]]);
  assert.equal(await watch()(), false, "a later leader reusing the ID");
  processes([[4200, 100, 4300, 9_000], [4300, 1, 4300, 8_000]]);
  assert.equal(await watch()(), false, "a later process reusing the ID in another group");
});

test("a background command runs while its process group lives, through exec or closed output, and MCP servers in Claude's group do not count", { skip: process.platform !== "linux" && "reads /proc" }, async (t) => {
  const { backgroundGroups, backgroundWatch } = await import("../images/pylon/nexus-heartbeat.ts");
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const start = async (script: string, detached: boolean) => {
    const child = spawn("bash", ["-c", script], { detached, stdio: "ignore" });
    t.after(() => { try { process.kill(detached ? -child.pid! : child.pid!, "SIGKILL"); } catch {} });
    await once(child, "spawn");
    return child;
  };
  const build = await start("exec sleep 30 >/dev/null 2>&1 <&-", true);
  const mcp = await start("exec sleep 30", false);
  while (!readFileSync(`/proc/${build.pid}/cmdline`, "utf8").startsWith("sleep")) await new Promise((resolve) => setTimeout(resolve, 10));
  const groups = await backgroundGroups(process.pid);
  assert.deepEqual(groups.map((g) => g.pgid), [build.pid]);
  const running = backgroundWatch("c1", ["b6fh14jr7"], groups);
  assert.equal(await running(), true);
  process.kill(-build.pid!, "SIGKILL");
  await once(build, "exit");
  assert.equal(await running(), false);
  mcp.kill();
});

test("a background command that left its group runs while a process writes to its output file", { skip: process.platform !== "linux" && "reads /proc" }, async (t) => {
  const { backgroundWatch } = await import("../images/pylon/nexus-heartbeat.ts");
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { mkdirSync, openSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "nexus-shell-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "c1", "tasks"), { recursive: true });
  const output = openSync(join(dir, "c1", "tasks", "b6fh14jr7.output"), "w");
  const child = spawn("sleep", ["30"], { stdio: ["ignore", output, output] });
  t.after(() => child.kill());
  await once(child, "spawn");
  assert.equal(await backgroundWatch("c1", ["b6fh14jr7"], [])(), true);
  assert.equal(await backgroundWatch("c1", ["bq5q9o836"], [])(), false);
  assert.equal(await backgroundWatch("c2", ["b6fh14jr7"], [])(), false);
  child.kill();
  await once(child, "exit");
  assert.equal(await backgroundWatch("c1", ["b6fh14jr7"], [])(), false);
});

test("only a Claude started outside other Claude sessions, under the pylon user's HOME, reports into the thread", async () => {
  const { reportsIntoThread } = await import("../images/pylon/nexus-heartbeat.ts");
  const home = "/home/user";
  const primary = "HOME=/home/user\0HERDR_ENV=1\0";
  const nested = "HOME=/home/user\0CLAUDE_CODE_SESSION_ID=37c5ec30-c691-4b40-992d-75e5cfd4eebc\0CLAUDE_PID=3445\0";
  assert.equal(reportsIntoThread({ HOME: home, CLAUDE_CODE_SESSION_ID: "336789b3" }, primary, home), true, "Claude sets the variable for its own hooks too");
  assert.equal(reportsIntoThread({ HOME: home }, nested, home), false, "a Claude another session's tool started");
  assert.equal(reportsIntoThread({ HOME: "/tmp/verify/home" }, primary, home), false, "a Claude under an isolated HOME");
  assert.equal(reportsIntoThread({ HOME: home }, "", home), true, "a Claude whose start is not known reports as before");
});

test("the environment a Claude started with is read from its process", { skip: process.platform !== "linux" && "reads /proc" }, async (t) => {
  const { claudeEnviron } = await import("../images/pylon/nexus-heartbeat.ts");
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const child = spawn("sleep", ["30"], { env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: "37c5ec30" } });
  t.after(() => child.kill());
  await once(child, "spawn");
  assert.match(await claudeEnviron(String(child.pid)), /(^|\0)CLAUDE_CODE_SESSION_ID=37c5ec30\0/);
  assert.equal(await claudeEnviron(undefined), "");
  assert.equal(await claudeEnviron("0"), "");
});

test("filtered reads advance the scanned watermark through retention rollover", () => {
  const registry = openRegistry(":memory:");
  try {
    let since = "0";
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 5000; i++) registry.appendEvent("release.changed", null, { message: "x".repeat(2048) });
      const result = registry.eventBatch(since, { kinds: ["session.turn-ended"] });
      assert.deepEqual(result.events, []);
      assert.equal(result.watermark, String((batch + 1) * 5000));
      since = result.watermark;
    }
    const matching = registry.appendEvent("session.turn-ended", null, {});
    assert.deepEqual(registry.eventBatch(since, { kinds: ["session.turn-ended"] }).events, [matching]);
  } finally { registry.close(); }
});

test("SQL filters before decoding payloads, including intersecting thread and project filters", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "nexus-event-filter-"));
  const path = join(dir, "registry.sqlite");
  const registry = openRegistry(path);
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare("INSERT INTO events (time, thread, project, kind, payload) VALUES (0, ?, ?, ?, ?)");
    insert.run("t1", "p1", "session.turn-ended", '{"match":true}');
    insert.run("t2", "p1", "session.turn-ended", "not JSON");
    insert.run("t1", "p2", "session.turn-ended", "not JSON");
    insert.run("t1", "p1", "release.changed", "not JSON");
    const result = registry.eventBatch("0", { thread: "t1", project: "p1", kinds: ["session.turn-ended", "session.waiting"] });
    assert.equal(result.watermark, "4");
    assert.deepEqual(result.events.map((e) => e.payload), [{ match: true }]);
  } finally { db.close(); registry.close(); rmSync(dir, { recursive: true, force: true }); }
});
