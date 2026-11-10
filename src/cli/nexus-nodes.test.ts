/**
 * nexus nodes, node and usage, against the control plane's real API with a fake harness behind it. src/test-
 * support/cli-kit.ts says when a test runs the CLI in its own process and when as a child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Thread } from "../control/thread-store.ts";
import type { PylonId } from "../ids.ts";
import type { NodeHealth } from "../protocol/client.ts";
import { stoppedPylon, testCapacity, testObservation } from "../test-support/kit.ts";
import { node, image, setup, timeless } from "../test-support/cli-kit.ts";
import { localTime } from "./kit.ts";

test("nodes marks an overcommitted node and says what its pylons hold", async (t) => {
  const s = await setup(t);
  const [up, paused, archived, crashed] = await Promise.all(["up", "paused", "archived", "crashed"].map((title) => s.json(["start", "--project", "acme", "--title", title]))) as Thread[];
  await s.nexus(["archive", archived!.id]);
  const capacity = testCapacity({ cpus: 8, committedCpus: 2, memoryGiB: 22.8, committedMemoryGiB: 40, committedDiskGiB: 30 });
  s.registry.threads.apply({ record: "node", node, state: "online", capacity });
  const stopped = (t: Thread) => stoppedPylon(t.pylonId, { sessions: null });
  s.registry.threads.ingested(testObservation(node, {
    capacity, artifacts: [image.id],
    pylons: [{ pylonId: up!.pylonId, phase: "booting" }, stopped(paused!), stopped(archived!), { pylonId: "pylon-x" as PylonId, phase: "booting" },
      { pylonId: crashed!.pylonId, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" }],
  }), []);
  const text = (await s.nexus(["nodes"])).stdout;
  assert.match(text, /^Node +State +Observed +Capacity$/m);
  assert.match(text, /^rj-firebat +online +\d+s ago \(.+\) {2}2\/8 CPUs, 40\/22\.8 GiB memory committed, overcommitted, 30 GiB disk committed, 100 GiB disk free$/m);
  assert.match(text, /^ {2}pylons: 1 up holding 2 CPUs and 4 GiB, 1 paused needing 4 GiB to wake, 1 archived, 1 crashed needing 4 GiB to retry, 1 orphaned \(pylon-x\)$/m);
});

test("nodes prints what an older probe does not count as unknown, never as 0, with --json or without", async (t) => {
  const s = await setup(t);
  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 } as never;
  s.registry.threads.apply({ record: "node", node, state: "online", capacity });
  const text = await s.nexus(["nodes"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^rj-firebat +online +.+ {2}unknown\/unknown CPUs, unknown\/64 GiB memory committed, unknown GiB disk committed, 100 GiB disk free$/m);
  assert.deepEqual((await s.json(["nodes"]))[0].capacity, capacity);
});

test("nodes says on a node's row which of its filesystems is low, and node prints each filesystem with its paths", async (t) => {
  const s = await setup(t);
  const disks = [
    { paths: ["/var/lib/nexus/pylons", "/var/lib/nexus/artifacts"], totalGiB: 1000, freeGiB: 99, pylons: true as const },
    { paths: ["/opt/nexus/releases"], totalGiB: 50, freeGiB: 30 },
  ];
  s.registry.threads.apply({ record: "node", node, state: "online", capacity: testCapacity({ diskFreeGiB: 99, disks }) });
  assert.match((await s.nexus(["nodes"])).stdout, /^rj-firebat +online +.+, 99 GiB disk free, disk low at \/var\/lib\/nexus\/pylons, \/var\/lib\/nexus\/artifacts$/m,
    "99 of 1000 GiB is under 10%, and 30 GiB of 50 is neither under 20 GiB nor under 10%");
  const health: NodeHealth = {
    node, readAt: "2027-01-01T00:00:00.000Z", cpus: 16, load: null, memory: null, disk: { path: "/var/lib/nexus/pylons", totalGiB: 1000, freeGiB: 99 }, disks, temperatures: null, pylons: null,
  };
  s.nodeHealth(async () => health);
  assert.match((await s.nexus(["node", node])).stdout,
    /\ndisk: 99\.0 of 1000\.0 GiB free at \/var\/lib\/nexus\/pylons, \/var\/lib\/nexus\/artifacts, low\ndisk: 30\.0 of 50\.0 GiB free at \/opt\/nexus\/releases\ntemperatures: unknown\n/);
});

test("usage backfill starts a run, --dry-run lists what it would read, --stop stops it, and usage prints the run in a line, with what it skipped once done", async (t) => {
  const s = await setup(t);
  const old: Thread = await s.json(["start", "--project", "acme", "--title", "Old work"]);
  const gone: Thread = await s.json(["start", "--project", "acme", "--title", "Gone"]);
  await s.json(["start", "--project", "acme", "--title", "Still going"]);
  for (const thread of [old, gone]) await s.json(["archive", thread.id]);
  const backfillLine = async () => (await s.nexus(["usage"])).stdout.split("\n").slice(1).join("\n").replace(/\nNo model calls[^]*$/, "");
  assert.equal(await backfillLine(), "Backfill: not run. A deployer runs `nexus usage backfill` to read archived threads' pylons.");

  const dry = await s.nexus(["usage", "backfill", "--dry-run"]);
  assert.equal(dry.stdout, `A start reads 2 archived threads, one pylon at a time:\nThread           Project  Node        Title\n${old.id}  acme     rj-firebat  Old work\n${gone.id}  acme     rj-firebat  Gone\n`);
  assert.deepEqual(await s.json(["usage", "backfill", "--dry-run"]), {
    backfill: { state: "never" },
    plan: [{ thread: old.id, project: "acme", node, title: "Old work", reason: null }, { thread: gone.id, project: "acme", node, title: "Gone", reason: null }],
  });
  assert.equal((await s.nexus(["usage", "backfill"])).stdout, "Backfill: running, 0 of 2 threads read, recovered 0 calls and 0 tokens.\n");
  assert.equal(await backfillLine(), "Backfill: running, 0 of 2 threads read, recovered 0 calls and 0 tokens. It waits: rj-firebat is offline.");
  assert.equal((await s.nexus(["usage", "backfill", "--stop"])).stdout, "Backfill: stopped at 0 of 2 threads read, recovered 0 calls and 0 tokens.\n");
  assert.equal((await s.json(["usage", "backfill", "--stop"])).state, "stopped", "--json prints the API's state");
  assert.equal((await s.nexus(["usage", "backfill", "--dry-run", "--stop"])).code, 64);

  s.registry.usage.startUsageBackfill([old.id, gone.id], Date.parse("2026-10-28T09:00:00Z"));
  s.registry.usage.recordUsage(old.id, Array.from({ length: 1234 }, (_, i) => ({ id: `claude:msg_${i}`, agent: "claude" as const, model: "claude-opus-5-5", at: 1_000, input: i === 0 ? 5_600_000 - 1233 : 1, output: 0, cacheWrite: 0, cacheRead: 0 })), [], true);
  s.registry.usage.finishUsageBackfillThread(old.id, "done", null, Date.parse("2026-10-28T09:10:00Z"));
  s.registry.usage.finishUsageBackfillThread(gone.id, "skipped", "rj-firebat holds no disk for its pylon", Date.parse("2026-10-28T09:11:00Z"));
  s.registry.usage.finishUsageBackfill(Date.parse("2026-10-28T09:12:00Z"));
  assert.equal(await backfillLine(), `Backfill: done at 2026-10-28 09:12 UTC, 2 of 2 threads read, 1 skipped, recovered 1234 calls and 5.6M tokens.\nSkipped:\nThread           Title  Why\n${gone.id}  Gone   rj-firebat holds no disk for its pylon`);
  assert.equal((await s.nexus(["usage", "backfill", "--dry-run"])).stdout, `A start reads 1 archived thread, one pylon at a time:\nThread           Project  Node        Title\n${gone.id}  acme     rj-firebat  Gone\n  skipped before: rj-firebat holds no disk for its pylon\n`);
});

test("usage prints the tokens of the last 7 days in all and by each breakdown, --since, --project and --by narrow it, and --json is the API's report", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Usage"]);
  const hour = 3_600_000;
  const call = (id: string, agent: "claude" | "pi", model: string, ago: number, [input, output, cacheWrite, cacheRead]: number[]) =>
    ({ id, agent, model, at: Date.now() - ago, input: input!, output: output!, cacheWrite: cacheWrite!, cacheRead: cacheRead! });
  s.registry.usage.recordUsage(thread.id, [
    call("claude:m1", "claude", "claude-opus-5-5", hour, [1_200, 300, 50_000, 1_250_000]),
    call("pi:r1", "pi", "gpt-6-astra", 72 * hour, [10_000, 2_000, 0, 30_000]),
    call("pi:r2", "pi", "gpt-6-astra", 20 * 24 * hour, [5_000_000, 0, 0, 0]),
  ]);

  const text = await s.nexus(["usage"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Usage of all projects since \d{4}-\d\d-\d\d \d\d:\d\d UTC\. Counting started \d{4}-\d\d-\d\d \d\d:\d\d UTC\.\nBackfill: not run\. .*\n\n/);
  const since = Date.parse(`${/since (\S+ \S+) UTC/.exec(text.stdout)![1]!.replace(" ", "T")}Z`);
  assert.equal(since, Date.now() - (Date.now() % (24 * hour)) - 6 * 24 * hour, "the period is today and the 6 UTC days before it unless --since says otherwise");
  assert.match(text.stdout, /\n +Input +Output +Cache write +Cache read +Total +Calls\nTotal +11\.2k +2\.3k +50k +1\.3M +1\.3M +2\n/, "the call 20 days ago is outside the period");
  assert.match(text.stdout, /\nBy model\nModel +Input +Output +Cache write +Cache read +Total +Calls\nclaude-opus-5-5 +1\.2k +300 +50k +1\.3M +1\.3M +1\ngpt-6-astra +10k +2k +0 +30k +42k +1\n/);
  assert.deepEqual([...text.stdout.matchAll(/^By .*$/gm)].map((m) => m[0]), ["By model", "By project", "By agent", "By role", "By day (UTC)"]);
  assert.match(text.stdout, /\nBy role\nRole +Input.*\nbuilder +11\.2k +2\.3k +50k +1\.3M +1\.3M +2\n/);

  const all = await s.json(["usage", "--since", "all"]);
  assert.deepEqual([all.since, all.project, all.thread], [null, null, null]);
  assert.deepEqual(all.total, { input: 5_011_200, output: 2_300, cacheWrite: 50_000, cacheRead: 1_280_000, total: 6_343_500, calls: 3 });
  assert.deepEqual(Object.keys(all.by), ["model", "project", "kind", "role", "day"]);
  assert.deepEqual(all.by.project, [{ key: "acme", input: 5_011_200, output: 2_300, cacheWrite: 50_000, cacheRead: 1_280_000, total: 6_343_500, calls: 3 }]);

  const byModel = await s.nexus(["usage", "--since", "30d", "--by", "model"]);
  assert.match(byModel.stdout, /\nTotal +5M .* 3\n\nBy model\n/);
  assert.deepEqual([...byModel.stdout.matchAll(/^By .*$/gm)].map((m) => m[0]), ["By model"], "--by prints only that breakdown");
  assert.deepEqual(Object.keys((await s.json(["usage", "--by", "day"])).by), ["day"]);

  const other = await s.nexus(["usage", "--project", "other", "--since", "2020-01-01"]);
  assert.match(other.stdout, /^Usage of project other since 2020-01-01 00:00 UTC\. Counting started .*\nBackfill: not run\. .*\nNo model calls were counted in this period\.\n$/);
  assert.equal((await s.nexus(["usage", "--by", "week"])).code, 64, "the API refuses an unknown breakdown");
  assert.equal((await s.nexus(["usage", "--since", "last week"])).code, 64, "and an unknown period");
});

test("node prints a node's health, unknown where the host exposes nothing, and --json the API's reply", async (t) => {
  const s = await setup(t);
  const health: NodeHealth = {
    node, readAt: "2027-01-01T00:00:00.000Z", cpus: 16, load: { one: 2.5, five: 1.75, fifteen: 1 },
    memory: { totalGiB: 62.8, availableGiB: 40.24, swapTotalGiB: 8, swapFreeGiB: 6 }, disk: { path: "/var/lib/nexus", totalGiB: 457.1, freeGiB: 180.33 },
    temperatures: [{ sensor: "k10temp Tctl", celsius: 54.125 }, { sensor: "nvme Composite", celsius: 41.85 }],
    pylons: [{ pylonId: "pylon-th-aaaaaaaaaaaa" as PylonId, processes: 2, cpuPercent: 112.46, residentGiB: 6.25 }, { pylonId: "pylon-th-bbbbbbbbbbbb" as PylonId, processes: 1, cpuPercent: 0, residentGiB: 0.1 }],
  };
  s.nodeHealth(async () => health);
  assert.deepEqual(await s.json(["node", node]), health);
  assert.equal(timeless((await s.nexus(["node", node])).stdout), [
    `node: ${node}, read ${localTime(Date.parse(health.readAt))}`,
    "load: 2.50 1.75 1.00 (1, 5, 15 min) on 16 CPUs",
    "memory: 40.2 of 62.8 GiB available",
    "swap: 2 of 8 GiB used",
    "disk: 180.3 of 457.1 GiB free at /var/lib/nexus",
    "temperatures: k10temp Tctl 54.1 °C, nvme Composite 41.9 °C",
    "pylon: pylon-th-aaaaaaaaaaaa, 2 processes, 112.5% CPU, 6.3 GiB resident",
    "pylon: pylon-th-bbbbbbbbbbbb, 1 process, 0% CPU, 0.1 GiB resident",
    "",
  ].join("\n"));
  s.nodeHealth(async () => ({ ...health, load: null, memory: null, temperatures: null, pylons: null }));
  assert.match((await s.nexus(["node", node])).stdout, /^load: unknown on 16 CPUs\nmemory: unknown\nswap: unknown\n.*\ntemperatures: unknown\npylons: unknown\n$/m);
});
