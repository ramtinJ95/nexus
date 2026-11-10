import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { reapGroup, signalGroup } from "./process-group.ts";

test("a group given no SIGTERM grace is sent SIGKILL before any wait, and reaped", async (t) => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const exited = once(child, "exit");
  t.after(async () => {
    try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await exited;
  });
  await once(child.stdout, "data");
  const sent: (NodeJS.Signals | 0)[] = [];
  signalGroup(child.pid!, "SIGTERM");
  await reapGroup(child.pid!, "the stand-in", async (name) => {
    sent.push(name);
    return signalGroup(child.pid!, name);
  }, 0);
  assert.equal(sent[0], "SIGKILL", "no liveness check waited out a grace first");
  assert.equal(signalGroup(child.pid!, 0), false, "the group is gone");
  assert.equal((await exited)[1], "SIGKILL");
});
