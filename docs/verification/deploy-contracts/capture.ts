// Runs the checkout's real control-plane API on loopback, posts the control node's healthy reports for both roles
// through the deployer's own jsonRequest, and then runs the checkout's real `nexus deploy main --wait` with its clock
// 120 seconds ahead of the control plane's, as a Mac's can be. Only tailscaled's whois is a stand-in. Writes what the
// wait printed, its exit and how long it took, or that it was still waiting when it was stopped.
// Run from the root of a checkout: node docs/verification/deploy-contracts/capture.ts <out-file>
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { startApi } = await import("../../../src/control/api.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { fakeHarness } = await import("../../../src/control/fake-harness.ts");
const { threadStarter } = await import("../../../src/control/threads.ts");
const { jsonRequest } = await import("../../../src/deploy/http.ts");
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;
type NodeName = import("../../../src/protocol.ts").NodeName;

const out = process.argv[2]!;
const stopAfterMs = 20_000;
const lines: string[] = [];
const log = (line: string) => { lines.push(line); console.log(line); };
const dir = await mkdtemp(join(tmpdir(), "deploy-contracts-capture-"));
const node = "nCONTROLNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const token = "a".repeat(64);
const desired = "a".repeat(40);
const short = (text: string) => text.replaceAll(desired, "<desired>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>");

const registry = openRegistry(join(dir, `${randomUUID()}.db`));
registry.upsertNode({ name: "control-node" as NodeName, tailnetHost: "control-node.tail.ts.net", tailnetNodeId: node });
let caller = node;
const fake = fakeHarness();
const startThread = threadStarter({ registry, harness: fake.harness, mirror: { setupInputs: () => Promise.reject(new Error("no remote")) }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, wake: () => {} });
const api = await startApi({
  registry, host: "127.0.0.1", port: 0, whois: async () => caller, allowed: new Set([laptop]),
  deployment: { self: node, deployers: new Set([laptop]), keys: { [node]: createHash("sha256").update(token).digest("hex") }, resolveMain: async () => desired },
  hostnames: new Set(["127.0.0.1"]), harness: fake.harness, startThread, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});
const url = `http://127.0.0.1:${api.port}/`;

for (const role of ["control", "probe"] as const) {
  await jsonRequest(new URL("/v1/deployer/report", url), "POST", { role, commit: desired, target: desired, state: "healthy", reason: null }, token, { id: node, whois: async () => node });
  log(`deployer reported ${role} healthy on <desired>`);
}
caller = laptop;

const skew = join(dir, "clock-ahead.mjs");
await writeFile(skew, "const now = Date.now; Date.now = () => now() + 120_000;\n");
log(`nexus deploy main --wait, its clock 120 s ahead of the control plane's`);
const started = performance.now();
const result = await new Promise<{ code: number | null; stdout: string; stderr: string; stopped: boolean }>((done) => {
  const child = execFile(process.execPath, ["--import", skew, "src/cli/nexus.ts", "deploy", "main", "--wait"], {
    env: { ...process.env, HOME: dir, NEXUS_URL: url, NEXUS_SOCKS: "none" }, timeout: stopAfterMs, killSignal: "SIGKILL",
  }, (error, stdout, stderr) => done({ code: child.exitCode, stdout, stderr, stopped: error?.killed === true }));
});
const seconds = Math.round((performance.now() - started) / 1000);
if (result.stopped) log(`still waiting after ${stopAfterMs / 1000} s, so it was stopped. The wait runs to its 30-minute timeout`);
else log(`exited ${result.code} after about ${seconds} s`);
for (const line of short(result.stdout + result.stderr).trim().split("\n")) if (line !== "") log(`  ${line}`);
log("the reports the control plane holds:");
for (const r of registry.releaseReports()) log(`  ${r.role} ${r.state} ${short(r.commit ?? "null")}`);

await api.close();
registry.close();
await rm(dir, { recursive: true, force: true });
await writeFile(out, `${lines.join("\n")}\n`);
