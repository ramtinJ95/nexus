import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { adoptControlPlane, parseControlPlane, readControlPlane, setControlPlane } from "./control-plane.ts";
import { parseWorkerConfig } from "./worker.ts";

const exec = promisify(execFile);
const firebat = "nFirebat1CNTRL";
const moved = { tailnetNodeId: "nMoved1CNTRL", url: "http://100.64.0.9:7470/" };
const token = "a".repeat(64);

async function etc(t: TestContext, probe?: unknown, deployer?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-control-plane-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (probe !== undefined) await writeFile(join(dir, "probe.json"), JSON.stringify(probe));
  if (deployer !== undefined) await writeFile(join(dir, "deployer.json"), JSON.stringify(deployer), { mode: 0o600 });
  return dir;
}
const probeJson = (controlPlane: string) => ({ node: "x", auth: { controlPlane, peers: [] } });
const deployerJson = (controlNodeId: string, controlUrl: string) => ({ controlUrl, controlNodeId, token, drainTimeoutMs: 300000, healthTimeoutMs: 60000 });

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

test("adopting writes the file once from the configs each node has today, and leaves it alone after", async (t) => {
  const nodes = { "rj-firebat": "http://100.64.0.2:7470/", "infra-testbench": "http://rj-firebat.tail1234.ts.net:7470/" };
  for (const [name, url] of Object.entries(nodes)) {
    const dir = await etc(t, probeJson(firebat), deployerJson(firebat, url));
    const path = join(dir, "control-plane.json");
    assert.equal(await adoptControlPlane(dir), "wrote", name);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { tailnetNodeId: firebat, url }, name);
    assert.equal((await stat(path)).mode & 0o777, 0o644, "the probe's user reads it");
    const bytes = await readFile(path);
    assert.equal(await adoptControlPlane(dir), "kept", name);
    assert.deepEqual(await readFile(path), bytes, name);
  }
});

test("adopting refuses configs that disagree on the control plane, and writes nothing", async (t) => {
  const dir = await etc(t, probeJson(firebat), deployerJson(moved.tailnetNodeId, moved.url));
  await assert.rejects(adoptControlPlane(dir), /name different control planes/);
  assert.equal(existsSync(join(dir, "control-plane.json")), false);
  const half = await etc(t, probeJson(firebat));
  await assert.rejects(adoptControlPlane(half), /deployer\.json names no control plane/);
  assert.equal(existsSync(join(half, "control-plane.json")), false);
});

test("once the file names a control plane, adopting keeps it, whatever the old keys say", async (t) => {
  const dir = await etc(t, probeJson(firebat), deployerJson(firebat, "http://100.64.0.2:7470/"));
  await writeFile(join(dir, "control-plane.json"), JSON.stringify(moved));
  assert.equal(await adoptControlPlane(dir), "kept");
  assert.deepEqual(await readControlPlane(join(dir, "control-plane.json")), moved);
  assert.equal(await adoptControlPlane(await etc(t)), "none", "a fresh machine, whose install writes the file");
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

test("the set command, run twice, writes the file and try-restarts the probe once", async (t) => {
  const dir = await etc(t);
  const bin = await etc(t);
  const log = join(bin, "systemctl.log");
  await writeFile(join(bin, "systemctl"), `#!/bin/sh\necho "$*" >>"${log}"\n`, { mode: 0o755 });
  const script = new URL("./control-plane.ts", import.meta.url).pathname;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const outputs = [];
  for (let i = 0; i < 2; i++) outputs.push((await exec(process.execPath, [script, "set", dir, moved.tailnetNodeId, moved.url], { env })).stdout);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["try-restart nexus-probe.service"]);
  assert.deepEqual(await readControlPlane(join(dir, "control-plane.json")), moved);
  assert.match(outputs[1]!, /already names control plane nMoved1CNTRL at http:\/\/100\.64\.0\.9:7470\//);
});

test("a deployer takes its control plane from the file, not from deployer.json's old keys", async (t) => {
  const dir = await etc(t);
  const path = join(dir, "control-plane.json");
  await writeFile(path, JSON.stringify(moved));
  const config = parseWorkerConfig(deployerJson(firebat, "http://100.64.0.2:7470/"), await readControlPlane(path));
  assert.equal(config.controlUrl, moved.url);
  assert.equal(config.controlNodeId, moved.tailnetNodeId);
  assert.equal(config.token, token);
});

test("adopting refuses a file that others may write, which the deployer would refuse on every poll", async (t) => {
  const dir = await etc(t, probeJson(firebat), deployerJson(firebat, "http://100.64.0.2:7470/"));
  assert.equal(await adoptControlPlane(dir), "wrote");
  await chmod(join(dir, "control-plane.json"), 0o664);
  await assert.rejects(adoptControlPlane(dir), /must belong to root and be writable by root alone/);
});

test("setting the control plane points the old keys a rollback or bootstrap worker reads at it too, keeping their modes", async (t) => {
  const dir = await etc(t, probeJson(firebat), deployerJson(firebat, "http://100.64.0.2:7470/"));
  let restarts = 0;
  const restart = async () => { restarts++; };
  assert.equal(await setControlPlane(dir, moved, restart), "wrote");
  const probe = JSON.parse(await readFile(join(dir, "probe.json"), "utf8"));
  const deployer = JSON.parse(await readFile(join(dir, "deployer.json"), "utf8"));
  assert.deepEqual(probe, probeJson(moved.tailnetNodeId));
  assert.deepEqual(deployer, deployerJson(moved.tailnetNodeId, moved.url));
  assert.equal((await stat(join(dir, "deployer.json"))).mode & 0o777, 0o600);
  assert.equal(await setControlPlane(dir, moved, restart), "unchanged");
  assert.equal(restarts, 1);

  const fresh = await etc(t, { node: "x", auth: { peers: [] } }, { token, drainTimeoutMs: 300000, healthTimeoutMs: 60000 });
  assert.equal(await setControlPlane(fresh, moved, restart), "wrote");
  assert.deepEqual(JSON.parse(await readFile(join(fresh, "probe.json"), "utf8")), { node: "x", auth: { peers: [] } }, "a probe.json without the old key gains none");
  assert.equal("controlUrl" in JSON.parse(await readFile(join(fresh, "deployer.json"), "utf8")), false);
});

test("a set that fails on a broken deployer.json changes nothing, and its retry restarts the probe", async (t) => {
  const dir = await etc(t, probeJson(firebat), deployerJson(firebat, "http://100.64.0.2:7470/"));
  assert.equal(await adoptControlPlane(dir), "wrote");
  await writeFile(join(dir, "deployer.json"), "{ not json", { mode: 0o600 });
  let restarts = 0;
  const restart = async () => { restarts++; };
  await assert.rejects(setControlPlane(dir, moved, restart), /deployer\.json: .*Nothing was changed/);
  assert.equal((await readControlPlane(join(dir, "control-plane.json"))).tailnetNodeId, firebat);
  assert.equal(JSON.parse(await readFile(join(dir, "probe.json"), "utf8")).auth.controlPlane, firebat);
  await writeFile(join(dir, "deployer.json"), JSON.stringify(deployerJson(firebat, "http://100.64.0.2:7470/")), { mode: 0o600 });
  assert.equal(await setControlPlane(dir, moved, restart), "wrote");
  assert.equal(restarts, 1);
  assert.deepEqual(await readControlPlane(join(dir, "control-plane.json")), moved);
});

test("a set whose probe restart fails puts the file back, so its retry restarts the probe", async (t) => {
  const dir = await etc(t, probeJson(firebat), deployerJson(firebat, "http://100.64.0.2:7470/"));
  assert.equal(await adoptControlPlane(dir), "wrote");
  await assert.rejects(setControlPlane(dir, moved, async () => { throw new Error("systemd is busy"); }), /systemd is busy/);
  assert.equal((await readControlPlane(join(dir, "control-plane.json"))).tailnetNodeId, firebat, "the file names the control plane the running probe trusts");
  let restarts = 0;
  assert.equal(await setControlPlane(dir, moved, async () => { restarts++; }), "wrote");
  assert.equal(restarts, 1);
});
