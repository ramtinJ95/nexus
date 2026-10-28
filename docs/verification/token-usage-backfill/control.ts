// The control plane of the backfill captures: startControlPlane from src/control/main.ts, the wiring a deployment runs,
// with the scripted model of src/harness/test-fixture.ts, on plain HTTP at 127.0.0.1:7470. It follows the probe that
// probe.ts runs on 127.0.0.1:7480. Its whois names the probe's port as the probe and every other caller as the Mac
// nLAPTOP, which is a caller and a deployer, so the CLI and the browser reach it as a person's Mac does. Its first start,
// on an empty WORK, records the image the probe's pylons boot from and makes it current, as nexus image rollout would.
//
//   WORK=<dir> node docs/verification/token-usage-backfill/control.ts
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { startControlPlane } from "../../../src/control/main.ts";
import { openRegistry } from "../../../src/control/registry.ts";
import { scriptedModel, scriptedModels } from "../../../src/harness/test-fixture.ts";
import { probePort, type NodeName, type TailnetNodeId } from "../../../src/protocol.ts";

const work = process.env.WORK!;
const ids = { control: "nVERIFYCONTROL" as TailnetNodeId, probe: "nVERIFYPROBE" as TailnetNodeId, laptop: "nLAPTOP" as TailnetNodeId };
const db = join(work, "registry.db");
if (!existsSync(db)) {
  const seed = openRegistry(db);
  seed.saveImage({ id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: "verify-node", builtAt: "2026-10-27T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never, null);
  seed.setCurrentImage("img-0000000000aa" as never);
  seed.close();
}

const socket = join(process.env.SOCKETS ?? work, "control-tailscaled.sock");
rmSync(socket, { force: true });
const tailscaled = createServer((req, res) => {
  const addr = new URL(req.url ?? "/", "http://local-tailscaled.sock").searchParams.get("addr") ?? "";
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: addr.endsWith(`:${probePort}`) ? ids.probe : ids.laptop } }));
});
await new Promise<void>((resolve) => tailscaled.listen(socket, resolve));

const controlPlane = await startControlPlane({
  db,
  listen: { host: "127.0.0.1", port: 7470, hostnames: ["127.0.0.1", "localhost"] },
  self: { tailnetNodeId: ids.control },
  nodes: [{ name: "verify-node" as NodeName, tailnetHost: "127.0.0.1", tailnetNodeId: ids.probe }],
  callers: [ids.laptop],
  deployers: [ids.laptop],
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  harness: { storage: join(work, "harness.sqlite"), credentials: join(work, "unused-credentials.json"), model: scriptedModel },
  tailscaledSocket: socket,
  previewPorts: { first: 10200, last: 10299 },
  resumeAfterUsageLimit: false,
} as never, scriptedModels());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void controlPlane.close().then(() => { tailscaled.close(); process.exit(0); }));
}
console.log(JSON.stringify({ api: controlPlane.port }));
