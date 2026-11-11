import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { coreHome, tempDir, unixSockets } from "../../test-support/kit.ts";
import { core, coreCall, CoreError, noCore, screenChars } from "./core.ts";
import { coreError, coreOk, fakeCore, fakeGuest } from "../../backends/fake-guest.ts";

const shell = { address: "t1", name: null, state: "live", labels: {}, argv: ["bash"], cwd: "/home/user", parent: null, foreground: null, status: null };

test("a call with no core running starts none and rejects as no_core, which a read can take as none", async () => {
  const off = fakeCore({ running: false });
  const guest = fakeGuest((argv) => off.reply(argv) ?? { exitCode: 1, output: "" });
  await assert.rejects(core(guest, "terminal.list", {}), (err) => err instanceof CoreError && err.kind === "no_core");
  assert.deepEqual(await core(guest, "terminal.list", {}).then((r) => r.terminals, noCore([])), []);
  assert.equal(off.running, false);
  await assert.rejects(core(fakeGuest(() => coreError("not_found")), "terminal.list", {}).catch(noCore([])), /not_found/, "noCore passes on every other failure");
});

test("an error reply rejects with Core's kind, a late call with its limit, and a result without the fields Nexus reads with the field", async () => {
  await assert.rejects(core(fakeGuest(() => coreError("name_taken", "a live terminal is already named \"x\"")), "terminal.get", { terminal: "x" }),
    (err) => err instanceof CoreError && err.kind === "name_taken" && /terminal\.get: a live terminal is already named/.test(err.message));
  await assert.rejects(core(fakeGuest(() => ({ exitCode: null, output: "" })), "terminal.list", {}, 3_000), /terminal\.list did not finish within 3000 ms/);
  await assert.rejects(core(fakeGuest(() => coreOk({ terminals: [{ ...shell, state: "gone" }] })), "terminal.list", {}), /terminal\.list result\.terminals\[0\]\.state/);
  await assert.rejects(core(fakeGuest(() => ({ exitCode: 1, output: "herdr-core: not found\n" })), "terminal.list", {}), /exited 1 without a JSON reply/);
  assert.deepEqual(await core(fakeGuest(() => coreOk({ terminals: [shell] })), "terminal.list", {}), { terminals: [shell] });
  await assert.rejects(core(fakeGuest(() => ({ ...coreOk({ terminals: [shell] }), truncated: true })), "terminal.list", {}), /terminal\.list's reply passed the guest's 65536-byte output limit/,
    "a cut reply is an error, even one that still parses");
});

test("in the guest, the call checks for a core before Core can start one, tells a crashed one's programs from none, and keeps only what Nexus reads of each terminal", { skip: unixSockets !== true && unixSockets }, async (t) => {
  const dir = await tempDir("nexus-core-call-", t);
  const user = await coreHome(t);
  const prompt = "p".repeat(20_000);
  const fat = { ...shell, screen: "s".repeat(30_000), records: { big: "r".repeat(10_000) }, argv: ["claude", "--resume", "id-1", prompt], foreground: { argv: ["claude", "--resume", "id-1", prompt], cwd: "/w", name: "claude", pid: 7 }, status: { state: "idle", app: "claude-code", msg: "m" } };
  const replies: Record<string, unknown> = {
    "terminal.list": { hidden_finished: 0, machines: [], terminals: [fat, fat] },
    "terminal.read": { text: "x".repeat(20_000) + "end\n\n", complete: true, how: "screen" },
  };
  await writeFile(join(dir, "replies.json"), JSON.stringify(replies));
  await writeFile(join(dir, "herdr-core"), `#!/bin/sh\ntouch ${dir}/started\nread -r request\nexec node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[JSON.parse(process.argv[2]).method]; console.log("a warning first"); console.log(JSON.stringify({ id: 1, jsonrpc: "2.0", result: r }))' ${dir}/replies.json "$request"\n`, { mode: 0o755 });
  const guest = fakeGuest((argv) => {
    const run = spawnSync(argv[0]!, argv.slice(1), { env: { ...user.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
    return { exitCode: run.status, output: run.stdout + run.stderr };
  });
  await assert.rejects(core(guest, "terminal.list", {}), (err) => err instanceof CoreError && err.kind === "no_core");
  await user.listen("holder");
  await assert.rejects(core(guest, "terminal.list", {}), (err) => err instanceof CoreError && err.kind === "core_lost");
  assert.equal(existsSync(join(dir, "started")), false, "herdr-core never ran");
  await user.listen("core");
  const { terminals } = await core(guest, "terminal.list", {});
  assert.equal(terminals.length, 2);
  assert.deepEqual(terminals[0]!.foreground, { argv: ["claude", "--resume", "id-1", prompt.slice(0, 256)], cwd: "/w", name: "claude" });
  assert.equal(terminals[0]!.argv[3], prompt.slice(0, 256));
  assert.deepEqual(terminals[0]!.status, { state: "idle", app: "claude-code" });
  const output = guest.execs.at(-1)!;
  assert.equal(output[2], coreCall);
  const { text } = await core(guest, "terminal.read", { terminal: "t1" });
  assert.equal(text.length, screenChars);
  assert.ok(text.endsWith("end"));
});
