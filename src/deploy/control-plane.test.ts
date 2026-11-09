import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { checkExistingControlPlane, parseControlPlane, parseWorkerConfig, readControlPlane, setControlPlane } from "./control-plane.ts";

const exec = promisify(execFile);
const firebat = "nFirebat1CNTRL";
const moved = { tailnetNodeId: "nMoved1CNTRL", url: "http://100.64.0.9:7470/" };
const token = "a".repeat(64);

const firebatPlane = { tailnetNodeId: firebat, url: "http://100.64.0.2:7470/" };

async function etc(t: TestContext, control?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-control-plane-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (control !== undefined) await writeFile(join(dir, "control-plane.json"), JSON.stringify(control), { mode: 0o644 });
  return dir;
}

test("a control plane is a stable node ID and a tailnet HTTP origin, and nothing else", () => {
  assert.deepEqual(parseControlPlane(moved), moved);
  assert.throws(() => parseControlPlane({ ...moved, name: "rj-firebat" }), /unknown keys name/);
  assert.throws(() => parseControlPlane({ ...moved, tailnetNodeId: "100.64.0.1" }), /tailnetNodeId must be the control plane's stable tailnet node ID/);
  assert.throws(() => parseControlPlane({ ...moved, tailnetNodeId: ["nMoved1CNTRL"] }), /tailnetNodeId/);
  for (const url of ["http://user:pass@100.64.0.9:7470/", "http://100.64.0.9:7470/api", "https://100.64.0.9/", "http://100.64.0.9/?a", "not a url"]) {
    assert.throws(() => parseControlPlane({ ...moved, url }), /url must be the control plane's tailnet HTTP origin/, url);
  }
  assert.throws(() => parseControlPlane([]), /JSON object/);
});

test("a missing file says what writes it, and a broken one names its path", async (t) => {
  const dir = await etc(t);
  const path = join(dir, "control-plane.json");
  await assert.rejects(readControlPlane(path), /control-plane\.json is missing\. deploy\/install\.sh writes it/);
  await writeFile(path, "{");
  await assert.rejects(readControlPlane(path), new RegExp(`^Error: ${path}: `));
});

test("checking keeps a file in the current form as it is, and a fresh machine has none yet", async (t) => {
  const dir = await etc(t, firebatPlane);
  const bytes = await readFile(join(dir, "control-plane.json"));
  assert.deepEqual(await checkExistingControlPlane(dir), firebatPlane);
  assert.deepEqual(await readFile(join(dir, "control-plane.json")), bytes);
  assert.equal(await checkExistingControlPlane(await etc(t)), undefined, "a fresh machine, whose install writes the file");
  await assert.rejects(checkExistingControlPlane(await etc(t, { ...firebatPlane, name: "rj-firebat" })), /control-plane\.json: has unknown keys name/);
});

test("setting the control plane restarts only when the file changes", async (t) => {
  const dir = await etc(t);
  let restarts = 0;
  const restart = async () => { restarts++; };
  assert.equal(await setControlPlane(dir, moved, restart), "wrote");
  assert.equal(restarts, 1);
  assert.equal(await setControlPlane(dir, { ...moved }, restart), "unchanged");
  assert.equal(await setControlPlane(dir, { ...moved, url: "http://100.64.0.9:7470" }, restart), "unchanged", "the same origin without its slash is the same control plane");
  assert.equal(restarts, 1);
  const other = { tailnetNodeId: firebat, url: "http://100.64.0.2:7470/" };
  assert.equal(await setControlPlane(dir, other, restart), "wrote");
  assert.equal(restarts, 2);
  assert.deepEqual(await readControlPlane(join(dir, "control-plane.json")), other);
  await assert.rejects(setControlPlane(dir, { ...other, url: "http://100.64.0.2:7470/x" }, restart), /url must be/);
  assert.equal(restarts, 2);
});

test("the set command restarts the probe once, and after a restart that stopped it and failed to start it, its retry starts it", async (t) => {
  const dir = await etc(t);
  const bin = await etc(t);
  const log = join(bin, "systemctl.log");
  const state = join(bin, "state");
  await writeFile(state, "active");
  // A stand-in for systemd: the second restart stops the probe and fails to start it, as a broken start would.
  await writeFile(join(bin, "systemctl"), `#!/bin/sh
echo "$*" >>"${log}"
case "$1" in
  show) echo loaded ;;
  restart) if [ -e "${bin}/fail-start" ]; then echo inactive >"${state}"; rm "${bin}/fail-start"; exit 1; fi; echo active >"${state}" ;;
esac
`, { mode: 0o755 });
  const script = new URL("./control-plane.ts", import.meta.url).pathname;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const set = (control: typeof moved) => exec(process.execPath, [script, "set", dir, control.tailnetNodeId, control.url], { env });
  await set(moved);
  assert.match((await set(moved)).stdout, /already names control plane nMoved1CNTRL at http:\/\/100\.64\.0\.9:7470\//);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["show nexus-probe.service --property=LoadState --value", "restart nexus-probe.service"]);

  const other = { tailnetNodeId: firebat, url: "http://100.64.0.2:7470/" };
  await writeFile(join(bin, "fail-start"), "");
  await assert.rejects(set(other), /the probe did not restart/);
  assert.equal(await readFile(state, "utf8"), "inactive\n");
  assert.deepEqual(await readControlPlane(join(dir, "control-plane.json")), moved, "the file names what the probe last trusted");
  await set(other);
  assert.equal(await readFile(state, "utf8"), "active\n", "the retry started the probe the failed restart left down");
  assert.deepEqual(await readControlPlane(join(dir, "control-plane.json")), other);
});

/** `node control-plane.ts set` with a stand-in systemctl whose body is `script`, logging every call. */
async function setWith(t: TestContext, script: string, dir: string, control = moved) {
  const bin = await etc(t);
  const log = join(bin, "systemctl.log");
  await writeFile(join(bin, "systemctl"), `#!/bin/sh\necho "$*" >>"${log}"\n${script}\n`, { mode: 0o755 });
  const cli = new URL("./control-plane.ts", import.meta.url).pathname;
  const run = exec(process.execPath, [cli, "set", dir, control.tailnetNodeId, control.url], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const result = await run.then(() => undefined, (err: Error) => err);
  return { error: result, calls: (await readFile(log, "utf8")).trim().split("\n") };
}

test("the set command restarts nothing on a machine without the probe's unit", async (t) => {
  const dir = await etc(t);
  const { error, calls } = await setWith(t, `[ "$1" != show ] || echo not-found`, dir);
  assert.equal(error, undefined);
  assert.deepEqual(calls, ["show nexus-probe.service --property=LoadState --value"]);
  assert.deepEqual(await readControlPlane(join(dir, "control-plane.json")), moved);
});

test("the set command restarts a probe that runs though it is not enabled at boot", async (t) => {
  const dir = await etc(t);
  const { error, calls } = await setWith(t, `case "$1" in is-enabled) exit 1 ;; is-active) echo active ;; show) echo loaded ;; esac`, dir);
  assert.equal(error, undefined);
  assert.ok(calls.includes("restart nexus-probe.service"), calls.join("\n"));
});

test("the set command fails, and leaves the file as it was, when systemctl cannot say whether there is a probe", async (t) => {
  const dir = await etc(t, firebatPlane);
  const { error, calls } = await setWith(t, `echo "Failed to connect to bus" >&2; exit 1`, dir);
  assert.match(String(error), /could not tell whether this machine has a probe/);
  assert.ok(!calls.includes("restart nexus-probe.service"), calls.join("\n"));
  assert.equal((await readControlPlane(join(dir, "control-plane.json"))).tailnetNodeId, firebat);
});

test("a deployer takes its control plane from the file", async (t) => {
  const dir = await etc(t);
  const path = join(dir, "control-plane.json");
  await writeFile(path, JSON.stringify(moved));
  const config = parseWorkerConfig({ token, drainTimeoutMs: 300000, healthTimeoutMs: 60000 }, await readControlPlane(path));
  assert.equal(config.controlUrl, moved.url);
  assert.equal(config.controlNodeId, moved.tailnetNodeId);
  assert.equal(config.token, token);
});

test("checking refuses a file that others may write, which the deployer would refuse on every poll", async (t) => {
  const dir = await etc(t, firebatPlane);
  await chmod(join(dir, "control-plane.json"), 0o664);
  await assert.rejects(checkExistingControlPlane(dir), /must belong to root and be writable by root alone/);
});

test("a set whose probe restart fails puts the file back, so its retry restarts the probe", async (t) => {
  const dir = await etc(t, firebatPlane);
  await assert.rejects(setControlPlane(dir, moved, async () => { throw new Error("systemd is busy"); }), /systemd is busy/);
  assert.deepEqual(await readControlPlane(join(dir, "control-plane.json")), firebatPlane, "the file names the control plane the running probe trusts");
  assert.equal((await stat(join(dir, "control-plane.json"))).mode & 0o777, 0o644);
  let restarts = 0;
  assert.equal(await setControlPlane(dir, moved, async () => { restarts++; }), "wrote");
  assert.equal(restarts, 1);
});
