import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseLoadavg, parseMeminfo, parseResident, parseStat, readNodeHealth } from "./host.ts";
import type { NodeName, PylonId } from "../protocol.ts";

const fixtures = new URL("../fixtures/host/", import.meta.url).pathname;
const node = "rj-firebat" as NodeName;
const kib = (n: number) => n / 2 ** 20;

test("each host source parses from its file: /proc/loadavg, /proc/meminfo, a process's stat and status", async () => {
  const proc = join(fixtures, "hwmon", "proc");
  assert.deepEqual(parseLoadavg(await readFile(join(proc, "loadavg"), "utf8")), { one: 1.22, five: 1.51, fifteen: 1.29 });
  assert.deepEqual(parseMeminfo(await readFile(join(proc, "meminfo"), "utf8")), { totalGiB: kib(6078296), availableGiB: kib(5404020), swapTotalGiB: kib(8388604), swapFreeGiB: kib(7340028) });
  assert.deepEqual(parseStat(await readFile(join(proc, "4122", "stat"), "utf8")), { pid: 4122, ppid: 4100, cpuTicks: 10_000 });
  assert.deepEqual(parseStat(await readFile(join(proc, "4200", "stat"), "utf8")), { pid: 4200, ppid: 4122, cpuTicks: 10 }, "a command name with spaces and parentheses");
  assert.equal(parseResident(await readFile(join(proc, "4122", "status"), "utf8")), 4);
  assert.equal(parseResident(await readFile(join(proc, "4200", "status"), "utf8")), 0, "a process with no VmRSS line, as a kernel thread has");
  assert.throws(() => parseMeminfo("MemTotal: 10 kB\n"), /no MemAvailable/);
  assert.throws(() => parseLoadavg("\n"), /loadavg reads/);
});

test("node health reads hwmon's sensors over the thermal zones, and each pylon's process tree over the sample", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(fixtures, "hwmon"), root, { recursive: true });
  // The sample takes 2 s, though it asked for 1, and the controller and QEMU use 2 CPU-seconds in it. The helper exits.
  let clock = 0;
  const wait = async () => {
    clock += 2_000;
    const bump = async (pid: number, ticks: number) => {
      const file = join(root, "proc", String(pid), "stat");
      const fields = (await readFile(file, "utf8")).split(" ");
      fields[13] = String(Number(fields[13]) + ticks);
      await writeFile(file, fields.join(" "));
    };
    await bump(4100, 50);
    await bump(4122, 150);
    await rm(join(root, "proc", "4200"), { recursive: true });
  };
  const pylons = [{ pylonId: "pylon-th-aaaaaaaaaaaa" as PylonId, pid: 4100 }, { pylonId: "pylon-th-bbbbbbbbbbbb" as PylonId, pid: 9999 }];
  const health = await readNodeHealth(node, { root, storage: root, pylons, sampleMs: 1000, wait, now: () => clock });
  assert.equal(health.node, node);
  assert.deepEqual(health.load, { one: 1.22, five: 1.51, fifteen: 1.29 });
  assert.equal(health.memory?.availableGiB, kib(5404020));
  assert.deepEqual(health.temperatures, [
    { sensor: "k10temp Tctl", celsius: 54.125 }, { sensor: "k10temp Tccd1", celsius: 51 },
    { sensor: "nvme Composite", celsius: 41.85 }, { sensor: "nvme temp2", celsius: 44.85 },
  ], "a sensor without a label is named by its input, a fan is no temperature, and the thermal zone repeats hwmon");
  assert.deepEqual(health.pylons, [{ pylonId: "pylon-th-aaaaaaaaaaaa", processes: 2, cpuPercent: 100, residentGiB: kib(102400 + 4194304) }],
    "CPU over the time the sample took, a pylon whose controller is gone not listed, and a process that exits during the sample not counted");
  assert.equal(health.disk.path, root);
  assert.ok(health.disk.freeGiB > 0 && health.disk.freeGiB <= health.disk.totalGiB);
  assert.ok(health.cpus > 0);
});

test("a host with only thermal zones reports them, and one without /proc or sensors reports each reading unknown", async () => {
  const thermal = await readNodeHealth(node, { root: join(fixtures, "thermal"), storage: fixtures, pylons: null, sampleMs: 0 });
  assert.deepEqual(thermal.temperatures, [{ sensor: "acpitz", celsius: 27.8 }, { sensor: "x86_pkg_temp", celsius: 48 }]);
  assert.deepEqual(thermal.load, { one: 0, five: 0.01, fifteen: 0.05 });
  assert.equal(thermal.pylons, null, "a backend that cannot name its pylons' processes");
  const bare = await readNodeHealth(node, { root: join(fixtures, "absent"), storage: fixtures, pylons: [], sampleMs: 0 });
  assert.deepEqual([bare.load, bare.memory, bare.temperatures, bare.pylons], [null, null, null, []]);
});

/** Has the files under `root` that `fails` names answer an errno, as a driver or an exiting process makes them. */
function failReads(t: TestContext, root: string, fails: Record<string, string>) {
  const original = fs.readFile;
  t.mock.method(fs, "readFile", (path: string, ...rest: unknown[]) => {
    const code = fails[relative(root, path)];
    if (code === undefined) return (original as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    return Promise.reject(Object.assign(new Error(`${code}: read '${path}'`), { code, syscall: "read", path }));
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("a sensor its driver keeps busy, or one it cannot read, is left out and the rest of the health stays", async (t) => {
  failReads(t, fixtures, { "hwmon/sys/class/hwmon/hwmon0/temp1_input": "EBUSY", "hwmon/sys/class/hwmon/hwmon1/temp2_input": "EACCES", "hwmon/sys/class/hwmon/hwmon1/temp1_label": "ENODATA" });
  const health = await readNodeHealth(node, { root: join(fixtures, "hwmon"), storage: fixtures, pylons: null, sampleMs: 0 });
  assert.deepEqual(health.temperatures, [{ sensor: "k10temp Tccd1", celsius: 51 }, { sensor: "nvme temp1", celsius: 41.85 }], "a label that cannot be read names the sensor by its input");
  assert.deepEqual(health.load, { one: 1.22, five: 1.51, fifteen: 1.29 });
});

test("a pylon's process that exits mid-read, or whose files refuse, is not counted, and the rest of the tree is", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(fixtures, "hwmon"), root, { recursive: true });
  failReads(t, root, { "proc/4122/status": "ESRCH", "proc/4200/stat": "EACCES" });
  let clock = 0;
  const wait = async () => {
    clock += 1_000;
    const file = join(root, "proc", "4122", "stat");
    const fields = (await readFile(file, "utf8")).split(" ");
    fields[13] = String(Number(fields[13]) + 100);
    await writeFile(file, fields.join(" "));
  };
  const health = await readNodeHealth(node, { root, storage: root, pylons: [{ pylonId: "pylon-th-aaaaaaaaaaaa" as PylonId, pid: 4100 }], sampleMs: 1000, wait, now: () => clock });
  assert.deepEqual(health.pylons, [{ pylonId: "pylon-th-aaaaaaaaaaaa", processes: 1, cpuPercent: 0, residentGiB: kib(102400) }]);
});

test("a pylon whose controller cannot be read at the end of the sample is not listed, though its children can be", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(fixtures, "hwmon"), root, { recursive: true });
  failReads(t, root, { "proc/4100/status": "ESRCH" });
  let clock = 0;
  const wait = async () => {
    clock += 1_000;
    await rm(join(root, "proc", "5000"), { recursive: true });
  };
  const pylons = [{ pylonId: "pylon-th-aaaaaaaaaaaa" as PylonId, pid: 4100 }, { pylonId: "pylon-th-bbbbbbbbbbbb" as PylonId, pid: 5000 }, { pylonId: "pylon-th-cccccccccccc" as PylonId, pid: 4122 }];
  const health = await readNodeHealth(node, { root, storage: root, pylons, sampleMs: 1000, wait, now: () => clock });
  assert.deepEqual(health.pylons, [{ pylonId: "pylon-th-cccccccccccc", processes: 2, cpuPercent: 0, residentGiB: 4 }],
    "a controller whose status fails, and one whose stat fails in the second sample, leave their pylons out");
});

test("load or memory that the host has but cannot read fails the health, and names the reading", async (t) => {
  failReads(t, fixtures, { "hwmon/proc/meminfo": "EIO", "thermal/proc/loadavg": "EBUSY" });
  await assert.rejects(readNodeHealth(node, { root: join(fixtures, "hwmon"), storage: fixtures, pylons: null, sampleMs: 0 }), /^Error: cannot read the node's memory: EIO: read '.*\/proc\/meminfo'$/);
  await assert.rejects(readNodeHealth(node, { root: join(fixtures, "thermal"), storage: fixtures, pylons: null, sampleMs: 0 }), /^Error: cannot read the node's load: EBUSY: read '.*\/proc\/loadavg'$/);
});
