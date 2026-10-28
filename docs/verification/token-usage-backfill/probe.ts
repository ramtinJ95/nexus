// The node of the backfill captures: the real probe (src/probe/server.ts) on 127.0.0.1:7480, whose backend keeps each
// pylon as a directory instead of a VM. The control plane runs in its own process (control.ts), so restarting it, as a
// deploy does, leaves this probe and its jobs running.
//  - WORK/pylons/<pylon>/home stands for the pylon's /home/user. A raw pipe runs as a local process, with every
//    /home/user/ path it is sent pointed there, so the usage reader reads the directory as it would the pylon's disk.
//    The pipe of a stopped pylon is refused, as a paused pylon's is.
//  - A spawn or pause changes the pylon's state.json and logs what it did to EVIDENCE/pylons.log: whether a boot from a
//    checkpoint relaunched the recorded sessions, which is what starts the pylon's agent, or left them for the next spawn.
//  - fail-boot in the pylon's directory fails its spawn with the file's text, as infra-testbench's VMs sometimes fail to
//    boot. fail-read makes its usage reader exit 1. hold-boot holds its spawn until the file is removed.
//  - Every pylon has one recorded Claude Code session, which its paused observation reports. A running pylon holds 1
//    CPU, 1 GiB of memory and 1 GiB of disk, and a paused one its disk only, as a pylon-vm does.
//
//   WORK=<dir> EVIDENCE=<dir> node docs/verification/token-usage-backfill/probe.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JobFailure, type BackendPylon, type Guest, type VmBackend } from "../../../src/backend.ts";
import type { CheckpointId, ImageId } from "../../../src/images.ts";
import { processStream } from "../../../src/process-stream.ts";
import { fakeTailscale } from "../../../src/probe/fake-tailscale.ts";
import { startProbe } from "../../../src/probe/server.ts";
import { localApiWhois } from "../../../src/tailscale.ts";
import { probePort, type NodeName, type PausedSession, type PylonId, type TailnetNodeId } from "../../../src/protocol.ts";

const work = process.env.WORK!;
const evidence = process.env.EVIDENCE!;
const node = "verify-node" as NodeName;
const image = "img-0000000000aa" as ImageId;
const ids = { control: "nVERIFYCONTROL" as TailnetNodeId, probe: "nVERIFYPROBE" as TailnetNodeId };
mkdirSync(join(work, "pylons"), { recursive: true });
const log = (line: string) => appendFileSync(join(evidence, "pylons.log"), `${new Date().toISOString()} ${line}\n`);

interface State { vm: "running" | "stopped"; checkpoint: CheckpointId | null; relaunchPending: boolean; bootedAt: string | null; sessions: readonly PausedSession[] }
const dir = (id: PylonId) => join(work, "pylons", id);
const stateOf = (id: PylonId): State | null => existsSync(join(dir(id), "state.json")) ? JSON.parse(readFileSync(join(dir(id), "state.json"), "utf8")) as State : null;
const save = (id: PylonId, s: State) => writeFileSync(join(dir(id), "state.json"), JSON.stringify(s, null, 2));
const recorded = (id: PylonId): PausedSession[] => [{ id: "w1:p1", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: `session-of-${id}`, title: "claude" }];

const backend: VmBackend = {
  async ensureRunning(boot, _live, signal, relaunch = true) {
    const id = boot.pylonId;
    mkdirSync(join(dir(id), "home"), { recursive: true });
    const was = stateOf(id);
    if (was?.vm === "running") {
      if (was.relaunchPending && relaunch) {
        save(id, { ...was, relaunchPending: false });
        log(`${id}: spawn of the running pylon relaunched the sessions its last boot left, so its agent started`);
      }
      return;
    }
    if (existsSync(join(dir(id), "hold-boot"))) log(`${id}: spawn${relaunch ? "" : " without relaunch"} held until hold-boot is removed`);
    while (existsSync(join(dir(id), "hold-boot"))) await delay(200, undefined, { signal });
    if (existsSync(join(dir(id), "fail-boot"))) {
      log(`${id}: spawn${relaunch ? "" : " without relaunch"} failed: ${readFileSync(join(dir(id), "fail-boot"), "utf8").trim()}`);
      throw new JobFailure("backend", readFileSync(join(dir(id), "fail-boot"), "utf8").trim());
    }
    const fromDisk = was !== null;
    save(id, { vm: "running", checkpoint: was?.checkpoint ?? null, relaunchPending: fromDisk && !relaunch, bootedAt: new Date().toISOString(), sessions: was?.sessions ?? recorded(id) });
    log(`${id}: spawn booted ${fromDisk ? `from ${was.checkpoint}` : "fresh"}${!fromDisk ? "" : relaunch ? " and relaunched its recorded sessions, so its agent started" : " without relaunching its sessions, which wait for the next spawn"}`);
  },
  async ensurePaused(id, checkpoint) {
    const was = stateOf(id);
    if (was === null || was.vm === "stopped") return;
    save(id, { ...was, vm: "stopped", checkpoint, bootedAt: null });
    log(`${id}: pause wrote ${checkpoint}${was.relaunchPending ? " and kept the sessions its last pause recorded, as they never came back" : " and recorded its sessions"}`);
  },
  async ensureDeleted(id) {
    if (!existsSync(dir(id))) return;
    rmSync(dir(id), { recursive: true });
    log(`${id}: deleted with its disk`);
  },
  async buildTemplate() { throw new JobFailure("invalid", "the verify node builds no templates"); },
  async buildImage() { throw new JobFailure("invalid", "the verify node builds no images"); },
  async list() {
    return readdirSync(join(work, "pylons")).flatMap((id): BackendPylon[] => {
      const s = stateOf(id as PylonId);
      if (s === null) return [];
      return [{
        pylonId: id as PylonId, vm: s.vm, checkpoint: s.checkpoint, image, bootedAt: s.bootedAt,
        holds: s.vm === "running" ? { cpus: 1, memoryGiB: 1, diskGiB: 1 } : { cpus: 0, memoryGiB: 0, diskGiB: 1 }, ...(s.vm === "stopped" ? { sessions: s.sessions } : {}),
      }];
    });
  },
  guest(id): Guest {
    const unavailable = async (): Promise<never> => { throw new Error("the verify node's pylons run only raw pipes"); };
    return {
      exec: unavailable,
      async stream(argv, streamLog) {
        if (stateOf(id)?.vm !== "running") throw new Error(`${id} is not running`);
        const failing = existsSync(join(dir(id), "fail-read"));
        log(`${id}: pipe ${argv.slice(0, 2).join(" ")} ...${failing ? " fails, as fail-read asks" : ""}`);
        const stream = failing ? processStream("sh", ["-c", "echo the transcripts could not be read >&2; exit 1"], streamLog) : processStream(argv[0]!, argv.slice(1), streamLog);
        return { ...stream, write: (chunk) => stream.write(Buffer.from(Buffer.from(chunk).toString().replaceAll("/home/user/", `${join(dir(id), "home")}/`))) };
      },
      writeFiles: async () => undefined,
      services: async () => ({ services: [] }),
      startService: unavailable,
      linkPort: unavailable,
      unlinkPort: unavailable,
      previewOrigin: () => "http://127.0.0.1:9",
    };
  },
  artifacts: {
    list: async (pylons) => [image, ...pylons.flatMap((p) => p.vm === "stopped" && p.checkpoint !== null ? [p.checkpoint] : [])],
    manifest: async () => null,
    export: unavailableArtifact,
    import: unavailableArtifact,
    drop: unavailableArtifact,
  },
  updateSecret: async () => [],
};
async function unavailableArtifact(): Promise<never> { throw new JobFailure("invalid", "the verify node moves no artifacts"); }

const socket = join(process.env.SOCKETS ?? work, "probe-tailscaled.sock");
rmSync(socket, { force: true });
const tailscaled = createServer((req, res) => {
  const addr = new URL(req.url ?? "/", "http://local-tailscaled.sock").searchParams.get("addr") ?? "";
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: addr.endsWith(`:${probePort}`) ? ids.probe : ids.control } }));
});
await new Promise<void>((resolve) => tailscaled.listen(socket, resolve));
const serve = fakeTailscale();
const probe = await startProbe({
  node, host: "127.0.0.1", port: probePort, auth: { controlPlane: ids.control, peers: [] }, whois: localApiWhois(socket), backend,
  secrets: { value: () => undefined, names: () => [], hold() {} },
  log: (message) => appendFileSync(join(evidence, "probe.log"), `${new Date().toISOString()} ${message}\n`),
  previews: { gatewayPort: 7481, routesFile: join(work, "preview-routes.json"), tailscale: serve.cli },
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void probe.close().then(() => { tailscaled.close(); process.exit(0); }));
}
console.log(JSON.stringify({ probe: probe.port, socket }));
