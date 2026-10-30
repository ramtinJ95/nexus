/**
 * Node validation that a pylon VM can use the memory it is given, run by hand on a home-lab node:
 *   node src/pylon-vm-memory.check.ts <image directory> <state root> [memory GiB, default 16] [GiB to touch, default memory - 2] [GiB to write to disk, default 3]
 *
 * It boots one fresh pylon, has the guest write to that many GiB of memory and hold them, and samples the host's
 * MemAvailable and the VM's resident set meanwhile. Then it writes to the pylon's disk and checks where the
 * running disk's writes land on the host: on a RAM-backed tmpfs they would cost host memory. Then it pauses the
 * pylon, wakes it from the checkpoint and checks that the written file survived. Then it kills the controller and its VM
 * outright, starts the pylon again and checks that the start reclaimed the running disk the kill left behind. It
 * deletes the pylon, also after a failure, and checks that nothing is left in the state root's scratch directory.
 * The state root must be at most 39 bytes. It prints PYLON_VM_MEMORY_CHECK_PASS last.
 */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { output } from "./exec.ts";
import type { CheckpointId } from "./images.ts";
import type { BootInputs } from "./project.ts";
import type { PylonId } from "./ids.ts";
import { parseMeminfo } from "./probe/host.ts";
import { checkBackend, checkBoot, emptyLive } from "./pylon-vm-check-kit.ts";

const [imageArg, stateArg, memoryArg, touchArg, diskArg] = process.argv.slice(2);
if (imageArg === undefined || stateArg === undefined) throw new Error("usage: node src/pylon-vm-memory.check.ts <image directory> <state root> [memory GiB] [GiB to touch]");
const imageDir = resolve(imageArg);
const stateRoot = resolve(stateArg);
const memoryGiB = Number(memoryArg ?? 16);
const touchGiB = Number(touchArg ?? memoryGiB - 2);
const diskGiB = Number(diskArg ?? 3);
assert.ok(Number.isInteger(memoryGiB) && Number.isInteger(touchGiB) && touchGiB > 0 && touchGiB < memoryGiB, "memory and touch are whole GiB, and touch is below memory");
assert.ok(Number.isInteger(diskGiB) && diskGiB > 0 && diskGiB < 6, "the disk write is whole GiB, and fits the 8 GiB disk");

const pylonId = `pylon-mem-${Date.now().toString(36)}` as PylonId;
const signal = () => AbortSignal.timeout(20 * 60_000);
const { backend, image } = checkBackend(imageDir, stateRoot);
const boot = (source: BootInputs["source"]) => checkBoot(pylonId, image, source, { memoryGiB });
const step = (name: string, value = "ok") => console.log(`${name}: ${value}`);
const sh = (script: string, timeoutMs = 60_000) => backend.guest(pylonId).exec(["sh", "-c", script], { cwd: "/home/user", timeoutMs });

const mib = (kib: number) => Math.round(kib / 1024);
async function hostAvailableMiB(): Promise<number> {
  return Math.round(parseMeminfo(await readFile("/proc/meminfo", "utf8")).availableGiB * 1024);
}
/**
 * The VM's qemu processes. Their command lines name only Gondolin's temporary files, so they are found as
 * descendants of the controller, whose command line names the instance directory.
 */
async function vmFamily(): Promise<{ pid: string; rssKiB: number; args: string }[]> {
  const stdout = await output("ps", ["-eo", "pid=,ppid=,rss=,args="]);
  const procs = stdout.trim().split("\n").map((line) => {
    const [pid, ppid, rss, ...args] = line.trim().split(/\s+/);
    return { pid: pid!, ppid: ppid!, rssKiB: Number(rss), args: args.join(" ") };
  });
  const instanceDir = join(stateRoot, "instances", pylonId);
  const family = new Set(procs.filter((p) => p.args.includes(instanceDir) && !p.args.includes("pylon-vm-memory.check")).map((p) => p.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) if (family.has(p.ppid) && !family.has(p.pid)) { family.add(p.pid); grew = true; }
  }
  return procs.filter((p) => family.has(p.pid));
}
const vmQemu = async () => (await vmFamily()).filter((p) => p.args.startsWith("qemu-system"));
const exists = (path: string) => stat(path).then(() => true, () => false);
const vmRssMiB = async () => mib((await vmQemu()).reduce((sum, p) => sum + p.rssKiB, 0));
async function fsType(path: string): Promise<string> {
  return (await output("findmnt", ["-n", "-o", "FSTYPE", "-T", path])).trim();
}
async function sample(label: string): Promise<void> {
  step(`HOST_${label}`, `MemAvailable=${await hostAvailableMiB()} MiB, VM RSS=${await vmRssMiB()} MiB`);
}

let failure: unknown = null;
try {
  await sample("BEFORE_BOOT");
  const booted = performance.now();
  await backend.ensureRunning(boot({ kind: "fresh", preSetup: null }), emptyLive, signal());
  step("BOOT_SECONDS", ((performance.now() - booted) / 1000).toFixed(1));
  const meminfo = await sh("grep -E 'MemTotal|MemAvailable' /proc/meminfo");
  step("GUEST_MEMINFO", meminfo.output.trim().replace(/\s+/g, " "));
  await sh("echo before-pause > /home/user/workspace/memory-marker");
  await sample("AFTER_BOOT");

  // Writes one byte per page so every page is backed, then holds the memory while the host samples it.
  const hold = 30;
  const touch = sh(`python3 -c "
import time
chunks = []
for i in range(${touchGiB}):
    b = bytearray(1 << 30)
    b[::4096] = b'\\x01' * (1 << 18)
    chunks.append(b)
    print('touched', i + 1, 'GiB', flush=True)
time.sleep(${hold})
print('released', flush=True)
"`, 10 * 60_000);
  let peakRss = 0;
  let lowAvailable = Number.POSITIVE_INFINITY;
  const sampler = setInterval(() => {
    void Promise.all([vmRssMiB(), hostAvailableMiB()]).then(([rss, available]) => {
      peakRss = Math.max(peakRss, rss);
      lowAvailable = Math.min(lowAvailable, available);
    });
  }, 1_000);
  const touched = await touch.finally(() => clearInterval(sampler));
  step("TOUCH_EXIT", String(touched.exitCode));
  step("TOUCH_TAIL", touched.output.trim().split("\n").slice(-2).join(" | "));
  assert.equal(touched.exitCode, 0, `the guest could not hold ${touchGiB} GiB: ${touched.output}`);
  assert.ok(touched.output.includes(`touched ${touchGiB} GiB`) && touched.output.includes("released"));
  step("PEAK_VM_RSS_MIB", String(peakRss));
  step("LOWEST_HOST_AVAILABLE_MIB", String(lowAvailable));
  assert.ok(peakRss >= touchGiB * 1024 * 0.9, `the VM's resident set peaked at ${peakRss} MiB, below the ${touchGiB} GiB the guest wrote`);
  await sample("AFTER_RELEASE");

  const alive = await sh("echo alive; dmesg 2>/dev/null | grep -ci 'out of memory' || true");
  step("GUEST_AFTER", alive.output.trim().replace(/\n/g, " "));
  assert.ok(alive.exitCode === 0 && alive.output.startsWith("alive"), "the guest answers after the load");

  const [qemu] = await vmQemu();
  const overlay = /-drive file=([^,]+)/.exec(qemu?.args ?? "")?.[1];
  assert.ok(overlay !== undefined, `no running disk on the qemu command line: ${qemu?.args}`);
  const before = (await stat(overlay)).blocks * 512;
  const wrote = await sh(`head -c ${diskGiB}G /dev/urandom > /home/user/workspace/disk-load && sync && ls -l /home/user/workspace/disk-load`, 10 * 60_000);
  assert.equal(wrote.exitCode, 0, wrote.output);
  const grown = (await stat(overlay)).blocks * 512 - before;
  step("DISK_OVERLAY", `${overlay} on ${await fsType(overlay)}, grew ${mib(grown / 1024)} MiB for a ${diskGiB} GiB write`);
  await sample("AFTER_DISK_WRITE");
  assert.ok(grown >= diskGiB * 2 ** 30 * 0.9, "the write reached the running disk");
  assert.notEqual(await fsType(overlay), "tmpfs", "the running disk's writes do not land in host RAM");

  const checkpoint = `ckpt-${pylonId}-1` as CheckpointId;
  const paused = performance.now();
  await backend.ensurePaused(pylonId, checkpoint, signal());
  step("PAUSE_SECONDS", ((performance.now() - paused) / 1000).toFixed(1));
  await sample("PAUSED");
  const woken = performance.now();
  await backend.ensureRunning(boot({ kind: "resume", checkpoint }), emptyLive, signal());
  step("WAKE_SECONDS", ((performance.now() - woken) / 1000).toFixed(1));
  const marker = await sh(`cat /home/user/workspace/memory-marker && stat -c %s /home/user/workspace/disk-load`);
  assert.equal(marker.output.trim(), `before-pause\n${diskGiB * 2 ** 30}`, "the wake kept the disk, the written file included");
  await sample("AFTER_WAKE");

  // A controller killed outright leaves its running disk behind, and the next start must reclaim it.
  const family = await vmFamily();
  const [crashed] = await vmQemu();
  const leftover = /-drive file=([^,]+)/.exec(crashed?.args ?? "")?.[1];
  assert.ok(leftover !== undefined, "the woken VM has a running disk");
  for (const p of family) process.kill(Number(p.pid), "SIGKILL");
  for (let i = 0; (await vmFamily()).length > 0; i++) {
    assert.ok(i < 100, "the killed controller and its VM are gone");
    await new Promise((r) => setTimeout(r, 100));
  }
  step("CRASH_LEFTOVER", `${leftover} exists=${await exists(leftover)}`);
  assert.ok(await exists(leftover), "the kill left the running disk behind");
  await backend.ensureRunning(boot({ kind: "resume", checkpoint }), emptyLive, signal());
  const [restarted] = await vmQemu();
  const fresh = /-drive file=([^,]+)/.exec(restarted?.args ?? "")?.[1];
  step("AFTER_CRASH_RESTART", `old exists=${await exists(leftover)}, new ${fresh}`);
  assert.ok(!(await exists(leftover)), "the restart reclaimed the crashed VM's running disk");
  assert.equal(await sh("cat /home/user/workspace/memory-marker").then((r) => r.output.trim()), "before-pause", "the restart came back from the checkpoint");
} catch (err) {
  failure = err;
  console.error(err);
} finally {
  await backend.ensureDeleted(pylonId, signal());
  await sample("AFTER_DELETE");
  const scratch = await readdir(join(stateRoot, "tmp")).catch(() => []);
  step("SCRATCH_AFTER_DELETE", JSON.stringify(scratch));
  if (failure === null && scratch.length > 0) failure = new Error(`the delete left ${scratch.join(", ")} in the scratch directory`);
}
if (failure !== null) process.exit(1);
console.log("PYLON_VM_MEMORY_CHECK_PASS");
