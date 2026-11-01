/** `nexus doctor`: one line per check under its node or the control plane, and an exit code that fails only on a fail. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../version.ts";
import type { DoctorReport } from "../control/doctor-model.ts";

const cli = fileURLToPath(new URL("./nexus.ts", import.meta.url));

/** A control plane that answers its health and `GET /v1/doctor` with `report`, and nothing else. */
async function doctor(t: TestContext, report: DoctorReport) {
  const server = createServer((req, res) => {
    const body = req.url === "/v1/health" ? { commit: null, version } : req.url === "/v1/doctor" ? report : null;
    res.writeHead(body === null ? 404 : 200, { "content-type": "application/json" }).end(JSON.stringify(body ?? { error: `no route ${req.url}` }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const home = await mkdtemp(join(tmpdir(), "nexus-doctor-cli-"));
  t.after(() => rm(home, { recursive: true }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return (args: readonly string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, "doctor", ...args], { env: { PATH: process.env.PATH!, HOME: home, NEXUS_URL: url, NEXUS_SOCKS: "none" } }, (err, stdout, stderr) => {
      resolve({ code: err === null ? 0 : (err as { code: number }).code, stdout, stderr });
    });
  });
}

const checks: DoctorReport["checks"] = [
  { node: null, name: "backup", status: "ok", text: "the newest backup, 2026-11-01T00-23-41Z, is 3 h old and verified" },
  { node: null, name: "certificate", status: "warn", text: "the dashboard's certificate for rj-firebat.example.ts.net expires in 5 days" },
  { node: "rj-firebat" as never, name: "online", status: "ok", text: "online and observed in the last 5 min" },
  { node: "rj-firebat" as never, name: "disk", status: "warn", text: "12.4 of 98.0 GiB free at /var/lib/nexus-control, low" },
  { node: "infra-testbench" as never, name: "online", status: "fail", text: "offline, last observed 3 h ago" },
];

test("doctor prints each check under the control plane or its node, and exits 1 with its report when one failed", async (t) => {
  const run = await doctor(t, { at: "2026-11-01T12:00:00.000Z", status: "fail", checks });
  const res = await run([]);
  assert.equal(res.code, 1, res.stderr);
  assert.equal(res.stderr, "");
  assert.equal(res.stdout, `control plane
  ok    backup       the newest backup, 2026-11-01T00-23-41Z, is 3 h old and verified
  warn  certificate  the dashboard's certificate for rj-firebat.example.ts.net expires in 5 days
rj-firebat
  ok    online       online and observed in the last 5 min
  warn  disk         12.4 of 98.0 GiB free at /var/lib/nexus-control, low
infra-testbench
  fail  online       offline, last observed 3 h ago
1 failed, 2 warned, 2 ok
`);
  const json = await run(["--json"]);
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.stdout), { at: "2026-11-01T12:00:00.000Z", status: "fail", checks });
});

test("doctor exits 0 when the checks only warned", async (t) => {
  const warned = checks.filter((c) => c.status !== "fail");
  const res = await (await doctor(t, { at: "2026-11-01T12:00:00.000Z", status: "warn", checks: warned }))([]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^0 failed, 2 warned, 2 ok$/m);
});
