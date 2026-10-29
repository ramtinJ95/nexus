// The control plane of the api-boundary captures: startControlPlane from src/control/main.ts, the wiring a deployment
// runs, on plain HTTP at 127.0.0.1:7470. Its whois names every caller the Mac nLAPTOP, a person and a deployer, except
// while WORK/stranger exists, when it names every caller nSTRANGER, which no allowlist holds. Its one node has no probe
// listening, so nothing here reaches a pylon.
//
//   WORK=<dir> SOCKETS=<short dir> node docs/verification/api-boundary/control.ts
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { startControlPlane } from "../../../src/control/main.ts";
import { scriptedModel, scriptedModels } from "../../../src/harness/test-fixture.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const work = process.env.WORK!;
const ids = { control: "nVERIFYCONTROL" as TailnetNodeId, probe: "nVERIFYPROBE" as TailnetNodeId, laptop: "nLAPTOP" as TailnetNodeId };
const socket = join(process.env.SOCKETS ?? work, "control-tailscaled.sock");
rmSync(socket, { force: true });
const tailscaled = createServer((_, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: existsSync(join(work, "stranger")) ? "nSTRANGER" : ids.laptop } }));
});
await new Promise<void>((resolve) => tailscaled.listen(socket, resolve));

const controlPlane = await startControlPlane({
  db: join(work, "registry.db"),
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
