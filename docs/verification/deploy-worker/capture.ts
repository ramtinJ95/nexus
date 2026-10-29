// Runs the checkout's root deployer worker against the checkout's real control-plane API on loopback, and writes every
// deployer request it sends, the drain the control plane holds after each one, every node command it runs and what the
// control plane reports at the end. Only tailscaled's whois and the node's services are stand-ins: each service answers
// /v1/health with the commit it was last restarted on, and systemctl, journalctl and the build log instead of acting.
// Run from the root of a checkout: node docs/verification/deploy-worker/capture.ts <out-file>
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { startApi } = await import("../../../src/control/api.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { fakeHarness } = await import("../../../src/control/fake-harness.ts");
const { threadStarter } = await import("../../../src/control/threads.ts");
const { jsonRequest } = await import("../../../src/deploy/http.ts");
const worker = await import("../../../src/deploy/worker.ts") as typeof import("../../../src/deploy/worker.ts") & { reconcileRoles?: unknown };
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;
type NodeName = import("../../../src/protocol.ts").NodeName;
type Role = "control" | "probe";

const out = process.argv[2]!;
const lines: string[] = [];
const log = (line: string) => lines.push(line);
const dir = await mkdtemp(join(tmpdir(), "deploy-worker-capture-"));
const node = "nCONTROLNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const token = "a".repeat(64);
const desired = "a".repeat(40);
const old = "b".repeat(40);
const short = (text: string) => text.replaceAll(desired, "<desired>").replaceAll(old, "<old>").replaceAll(dir, "<dir>");
const config = { controlUrl: "", controlNodeId: node, token, drainTimeoutMs: 0, healthTimeoutMs: 1000 };

/** A control plane, and one node running both roles on `linked` under a fresh prefix. */
async function machine(name: string, linked: string) {
  const prefix = join(dir, name);
  const registry = openRegistry(join(dir, `${randomUUID()}.db`));
  registry.upsertNode({ name: "control-node" as NodeName, tailnetHost: "control-node.tail.ts.net", tailnetNodeId: node });
  registry.setDesiredRelease({ commit: desired, requestedBy: laptop, requestedAt: 0 });
  const fake = fakeHarness();
  const startThread = threadStarter({ registry, harness: fake.harness, mirror: { setupInputs: () => Promise.reject(new Error("no remote")) }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, wake: () => {} });
  const api = await startApi({
    registry, host: "127.0.0.1", port: 0, whois: async () => node, allowed: new Set([laptop]),
    deployment: { self: node, deployers: new Set([laptop]), keys: { [node]: createHash("sha256").update(token).digest("hex") } },
    hostnames: new Set(["127.0.0.1"]), harness: fake.harness, startThread, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
  });
  const url = `http://127.0.0.1:${api.port}/`;
  const reads = { release: 0 };
  const call = async (path: string, body?: unknown) => {
    if (path === "release") reads.release++;
    const answer = await jsonRequest(new URL(`/v1/deployer/${path}`, url), body === undefined ? "GET" : "POST", body, token, { id: node, whois: async () => node });
    const drain = registry.drain();
    const sent = body === undefined ? "" : ` ${JSON.stringify(path === "report" ? { state: (body as any).state, target: (body as any).target, reason: (body as any).reason } : body)}`;
    log(short(`  ${body === undefined ? "GET" : "POST"} /v1/deployer/${path}${sent}; drain now ${drain === null ? "none" : `held${drain.locked ? ", sealed" : ""}`}`));
    return answer;
  };
  await mkdir(join(prefix, "deployer"), { recursive: true });
  await mkdir(join(prefix, "etc"));
  await mkdir(join(prefix, "units"));
  for (const commit of new Set([linked, old])) {
    await mkdir(join(prefix, "releases", commit), { recursive: true });
    await writeFile(join(prefix, "releases", commit, "release-commit"), `${commit}\n`);
  }
  const running: Record<Role, string> = { control: linked, probe: linked };
  const servers: ReturnType<typeof createServer>[] = [];
  for (const role of ["control", "probe"] as const) {
    await symlink(`releases/${linked}`, join(prefix, role === "control" ? "control-current" : "current"));
    await writeFile(join(prefix, "units", `nexus-${role}.service`), `${role} unit\n`);
    const server = createServer((_req, res) => res.end(JSON.stringify({ commit: running[role] }))).listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    await writeFile(join(prefix, "etc", `${role}.json`), JSON.stringify({ listen: { host: "127.0.0.1", port: (server.address() as { port: number }).port } }));
  }
  const boundary = {
    prefix, etc: join(prefix, "etc"), units: join(prefix, "units"),
    async checkout() { log("  run: git checkout <desired>"); },
    async run(program: string, args: readonly string[]) {
      log(short(`  run: ${program === process.execPath ? "node" : program} ${args.join(" ")}`));
      if (program === "env" && !args.includes("NEXUS_PREPARE=1")) {
        await mkdir(join(prefix, "releases", desired), { recursive: true });
        await writeFile(join(prefix, "releases", desired, "release-commit"), `${desired}\n`);
      }
      if (program === "systemctl" && args[0] === "restart") running[args[1]!.replace(/^nexus-|\.service$/g, "") as Role] = desired;
      return program === "journalctl" ? "journal tail" : "";
    },
  };
  const poll = async (roles: Role[]) => {
    const live = { ...config, controlUrl: url };
    if (typeof worker.reconcileRoles === "function") await (worker.reconcileRoles as (...a: unknown[]) => Promise<void>)(roles, live, call, boundary);
    else for (const role of roles) await worker.reconcileRole(role, live, call, boundary);
  };
  const reportFile = async (role: Role) => {
    const path = join(prefix, `${role}-deploy-report.json`);
    const s = await stat(path).catch(() => null);
    return s === null ? "absent" : `${s.ino}:${s.mtimeMs}:${await readFile(path, "utf8")}`;
  };
  return {
    prefix, reads, poll, reportFile,
    async reports() {
      const view = await jsonRequest(new URL("/v1/deployer/release", url), "GET", undefined, token, { id: node, whois: async () => node });
      return (view.nodes as { role: string; commit: string | null; target: string | null; state: string; reason: string | null }[])
        .map((r) => short(`  ${r.role}: commit ${r.commit} target ${r.target} ${r.state}${r.reason === null ? "" : `: ${r.reason.split("\n")[0]}`}`));
    },
    async close() { for (const s of servers) { s.closeAllConnections(); s.close(); } await api.close(); registry.close(); },
  };
}

log("# A control release rolled back at the desired commit, with its report file cleared (#228)");
{
  const m = await machine("journal-quarantine", old);
  await writeFile(join(m.prefix, "control-deploy.json"), JSON.stringify({ commit: desired, previous: `releases/${old}`, target: `releases/${desired}`, state: "rolled-back", reason: "release health check failed\njournal tail" }));
  log("poll, control role:");
  await m.poll(["control"]);
  log("control plane's reports:");
  for (const line of await m.reports()) log(line);
  await m.close();
}

log("");
log("# A control drain refusal at the desired commit, held in the report file alone");
{
  const m = await machine("report-quarantine", old);
  await writeFile(join(m.prefix, "control-deploy-report.json"), JSON.stringify({ role: "control", commit: old, target: desired, state: "failed", reason: "Error: agent turn still running at drain timeout", observedAt: 0 }));
  log("poll, control role:");
  await m.poll(["control"]);
  log("control plane's reports:");
  for (const line of await m.reports()) log(line);
  await m.close();
}

log("");
log("# Two idle polls of a machine with both roles on the desired release (#233)");
{
  const m = await machine("idle", desired);
  for (const poll of [1, 2]) {
    m.reads.release = 0;
    const before = { control: await m.reportFile("control"), probe: await m.reportFile("probe") };
    log(`poll ${poll}:`);
    await m.poll(["control", "probe"]);
    log(`  release view reads: ${m.reads.release}`);
    for (const role of ["control", "probe"] as const) log(`  ${role} report file: ${before[role] === "absent" ? "written" : before[role] === await m.reportFile(role) ? "untouched" : "rewritten"}`);
  }
  log("control plane's reports:");
  for (const line of await m.reports()) log(line);
  await m.close();
}

log("");
log("# One poll of a machine with both roles a release behind (#233)");
{
  const m = await machine("upgrade", old);
  log("poll:");
  await m.poll(["control", "probe"]);
  log(`  release view reads: ${m.reads.release}`);
  log("control plane's reports:");
  for (const line of await m.reports()) log(line);
  await m.close();
}

await writeFile(out, `${lines.join("\n")}\n`);
await rm(dir, { recursive: true, force: true });
