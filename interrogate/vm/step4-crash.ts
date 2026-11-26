// Step 4: SIGKILL of the per-VM Node controller, then of QEMU, while a guest command runs (pylon-vm, Gondolin's default image).
import { setTimeout as sleep } from "node:timers/promises";
import { run } from "../../src/pylon-vm/client.ts";
import { controllerLog, create, destroy, exec, inspect, pids, root, sh, start, stop } from "./kit.ts";

const name = "crash";
const alive = (pid: number | null) => { if (pid === null) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const recorded = () => run(root, { action: "recorded", name } as never).then((r: any) => r?.state ?? JSON.stringify(r).slice(0, 120), (e) => `error: ${String(e).slice(0, 160)}`);
const state = () => inspect(name).then((r) => r.state, (e) => `error: ${String(e).slice(0, 160)}`);
const files = async () => (await sh(name, "ls /root; echo counter=$(tail -1 /root/counter 2>/dev/null); pgrep -f 'counter-loop' >/dev/null && echo loop-running || echo loop-gone")).output.trim().replace(/\n/g, " | ");
const loop = "sh -c 'echo counter-loop >/dev/null; i=0; while true; do echo $i >> /root/counter; i=$((i+1)); sleep 1; done'";

async function crash(label: string, victim: "controller" | "qemu") {
  const before = pids(name);
  const started = await exec(name, loop, 2_000);
  console.log(`[${label}] command running: ${started.running}; pids ${JSON.stringify(before)}`);
  await sleep(5_000);
  const counterBefore = (await sh(name, "tail -1 /root/counter")).output.trim();
  process.kill(before[victim]!, "SIGKILL");
  const t0 = performance.now();
  for (const at of [1_000, 5_000, 15_000]) {
    await sleep(at - (performance.now() - t0));
    console.log(`[${label}] +${at / 1000}s: controller alive ${alive(before.controller)}, qemu alive ${alive(before.qemu)}, inspect ${await state()}, recorded ${await recorded()}`);
  }
  console.log(`[${label}] counter was ${counterBefore} at the kill`);
  const exe = await exec(name, "echo reachable", 5_000).then((r) => `exec answered: ${JSON.stringify(r).slice(0, 120)}`, (e) => `exec refused: ${String(e).slice(0, 160)}`);
  console.log(`[${label}] ${exe}`);
  if (victim === "qemu" && alive(before.controller)) {
    // A controller left without its VM: stop settles it, as the backend's retry would.
    console.log(`[${label}] stop -> ${await stop(name).then((r) => JSON.stringify(r).slice(0, 160), (e) => String(e).slice(0, 200))}`);
  }
  const s = await start(name, 1).catch((e) => ({ ms: 0, reply: String(e).slice(0, 300) }));
  console.log(`[${label}] start after the kill: ${Math.round(s.ms)} ms, ${JSON.stringify(s.reply).slice(0, 200)}`);
  console.log(`[${label}] guest after restart: ${await files()}; new pids ${JSON.stringify(pids(name))}; old qemu alive ${alive(before.qemu)}`);
}

try {
  await create(name, 1);
  await sh(name, "echo kept > /root/written-before-checkpoint && sync");
  console.log("stop (checkpoint):", JSON.stringify(await stop(name)).slice(0, 120));
  console.log("start:", Math.round((await start(name, 1)).ms), "ms");
  await sh(name, "echo lost? > /root/written-after-checkpoint-A && sync");
  await crash("A: SIGKILL controller", "controller");
  await sh(name, "rm -f /root/counter; echo lost? > /root/written-after-checkpoint-B && sync");
  await crash("B: SIGKILL qemu", "qemu");
} catch (e) {
  console.log("FAILED", String(e)); console.log(controllerLog(name));
} finally {
  console.log("destroy", JSON.stringify(await destroy(name).catch((e) => String(e))));
  console.log("leftover qemu children of our controllers:", JSON.stringify(pids(name)));
}
