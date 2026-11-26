// Timing steps 1, 2, 6 (and 3 with `density`): real pylon-vm controller + Gondolin 0.13.0 + QEMU, Gondolin's default
// Alpine image, 2 vCPUs. Usage: node timing.ts boot|cost|checkpoint|density
import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { availableMiB, controllerLog, cpuSeconds, create, destroy, exec, otherQemu, pids, root, rssMiB, sh, start, stop } from "./kit.ts";

const what = process.argv[2];
const others = () => console.log(`other qemu on the host: ${otherQemu().filter((l) => !l.includes("nx-a1f") && !l.includes("agent-a1f03cacb8bc2f7e4")).map((l) => l.split(" ")[0] + " " + (/-name (\S+)/.exec(l)?.[1] ?? /-m (\S+)/.exec(l)?.[0] ?? "")).join("; ") || "none"}; host MemAvailable ${availableMiB()} MiB; load ${execFileSync("cat", ["/proc/loadavg"], { encoding: "utf8" }).trim()}`);
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return `min ${s[0]} median ${s[Math.floor(s.length / 2)]} max ${s.at(-1)} (n=${s.length})`; };
const duMiB = (dir: string) => Math.round(Number(execFileSync("du", ["-sbL", dir], { encoding: "utf8" }).split("\t")[0]) / 1048576);
const fileSizes = (dir: string) => readdirSync(dir).filter((f) => !f.endsWith(".sock")).map((f) => { const s = statSync(`${dir}/${f}`); return `${f}=${Math.round(s.size / 1048576)}MiB(alloc ${Math.round(s.blocks * 512 / 1048576)}MiB)`; }).join(" ");

async function boot() {
  others();
  const created: number[] = [], shell: number[] = [];
  for (let i = 0; i < 6; i++) {
    const name = `boot${i}`;
    try {
      const t0 = performance.now();
      await create(name, 2);
      const t1 = performance.now();
      await exec(name, "true", 30_000);
      const t2 = performance.now();
      created.push(Math.round(t1 - t0)); shell.push(Math.round(t2 - t0));
      console.log(`boot ${i}: create returned ${Math.round(t1 - t0)} ms, first command answered ${Math.round(t2 - t0)} ms`);
    } catch (e) { console.log(`boot ${i} FAILED ${String(e).slice(0, 200)}\n${controllerLog(name, 600)}`); }
    finally { await destroy(name).catch(() => {}); }
  }
  console.log(`cold boot to first command: ${stats(shell)}; create alone: ${stats(created)}`);
  others();
}

async function cost() {
  others();
  const name = "cost";
  try {
    await create(name, 2);
    const p = pids(name);
    await sleep(20_000);
    const sample = async (label: string, seconds: number) => {
      const c0 = cpuSeconds(p.controller)!, q0 = cpuSeconds(p.qemu)!;
      await sleep(seconds * 1000);
      const c1 = cpuSeconds(p.controller)!, q1 = cpuSeconds(p.qemu)!;
      console.log(`${label}: controller RSS ${rssMiB(p.controller)} MiB, CPU ${((c1 - c0) / seconds * 100).toFixed(1)}% | qemu RSS ${rssMiB(p.qemu)} MiB, CPU ${((q1 - q0) / seconds * 100).toFixed(1)}% (over ${seconds} s)`);
    };
    await sample("idle 2 GiB guest", 30);
    const touch = await exec(name, "python3 -c \"import time; b=bytearray(1600*1024*1024); [b.__setitem__(i,1) for i in range(0,len(b),4096)]; print('touched', flush=True); time.sleep(40)\"", 30_000);
    console.log("touch command:", JSON.stringify(touch).slice(0, 120));
    await sleep(5_000);
    await sample("guest holding 1600 MiB", 20);
    await sleep(25_000);
    console.log("guest free after the toucher exited:", (await sh(name, "free -m | sed -n 2p")).output.trim());
    await sample("after the guest freed it", 20);
  } catch (e) { console.log(`FAILED ${String(e)}\n${controllerLog(name, 800)}`); }
  finally { await destroy(name).catch(() => {}); }
  others();
}

async function checkpoint() {
  others();
  const name = "ckpt";
  try {
    await create(name, 2);
    const dir = `${root}/instances/${name}`;
    const w = await sh(name, "dd if=/dev/urandom of=/root/data bs=1M count=300 2>&1 | tail -1; sync; sha256sum /root/data");
    console.log("wrote:", w.output.trim().replace(/\n/g, " | "));
    const before = w.output.trim().split("\n").at(-1)!.split(" ")[0];
    for (let round = 1; round <= 3; round++) {
      const t0 = performance.now(); await stop(name); const stopMs = Math.round(performance.now() - t0);
      console.log(`round ${round}: stop (checkpoint) ${stopMs} ms; instance dir ${duMiB(dir)} MiB: ${fileSizes(dir)}`);
      const t1 = performance.now(); await start(name, 2); await exec(name, "true", 30_000); const startMs = Math.round(performance.now() - t1);
      const sum = (await sh(name, "sha256sum /root/data")).output.trim().split(" ")[0];
      console.log(`round ${round}: start (resume) to first command ${startMs} ms; data intact ${sum === before}`);
    }
  } catch (e) { console.log(`FAILED ${String(e)}\n${controllerLog(name, 800)}`); }
  finally { await destroy(name).catch(() => {}); }
  others();
}

async function density() {
  others();
  const names: string[] = [];
  let first = 0;
  try {
    for (let i = 0; i < 12; i++) {
      if (availableMiB() < 8 * 1024 + 900) { console.log(`stop: host MemAvailable ${availableMiB()} MiB would fall below 8 GiB with another VM`); break; }
      const name = `den${i}`;
      const t0 = performance.now();
      try { await create(name, 0.5); await exec(name, "true", 30_000); }
      catch (e) { console.log(`stop: VM ${i + 1} failed to boot: ${String(e).slice(0, 200)}\n${controllerLog(name, 500)}`); names.push(name); break; }
      names.push(name);
      const ms = Math.round(performance.now() - t0);
      if (i === 0) first = ms;
      const per = names.map((n) => { const p = pids(n); return (rssMiB(p.controller) ?? 0) + (rssMiB(p.qemu) ?? 0); });
      console.log(`VM ${i + 1}: boot ${ms} ms; host MemAvailable ${availableMiB()} MiB; controller+qemu RSS per VM ${per.join(",")} MiB`);
      if (ms > 2 * first && i > 0) { console.log(`stop: boot time ${ms} ms is over twice the first (${first} ms)`); break; }
    }
    if (names.length === 12) console.log("stop: 12 VMs, the cap");
    // Idle CPU of the whole set.
    const all = names.flatMap((n) => { const p = pids(n); return [p.controller, p.qemu]; }).filter((x): x is number => x !== null);
    const c0 = all.map((p) => cpuSeconds(p) ?? 0);
    await sleep(20_000);
    const c1 = all.map((p) => cpuSeconds(p) ?? 0);
    console.log(`idle CPU of all ${names.length} VMs (controllers + qemu): ${((c1.reduce((a, b) => a + b, 0) - c0.reduce((a, b) => a + b, 0)) / 20 * 100).toFixed(1)}% of one core`);
  } finally {
    for (const n of names) await destroy(n).catch(() => {});
  }
  others();
}

await ({ boot, cost, checkpoint, density } as Record<string, () => Promise<void>>)[what!]!();
