// The control plane of the cli-loops captures: startControlPlane from src/control/main.ts, the wiring a deployment
// runs, on plain HTTP at 127.0.0.1:7470, and a SOCKS5 proxy at 127.0.0.1:7471 that alone resolves nexus.verify to it,
// as ts-home's proxy alone knows MagicDNS. The proxy appends a line to WORK/connects for each CONNECT. Its whois names
// every caller the Mac nLAPTOP, a person and a deployer. The registry holds a current image, so a thread starts, but its
// one node has no probe listening, so nothing here reaches a pylon.
//
//   WORK=<dir> SOCKETS=<short dir> node docs/verification/cli-loops/control.ts
import { appendFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { startControlPlane } from "../../../src/control/main.ts";
import { openRegistry } from "../../../src/control/registry.ts";
import { testImage } from "../../../src/test-kit.ts";
import { scriptedModel, scriptedModels } from "../../../src/harness/test-fixture.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const work = process.env.WORK!;
const ids = { control: "nVERIFYCONTROL" as TailnetNodeId, probe: "nVERIFYPROBE" as TailnetNodeId, laptop: "nLAPTOP" as TailnetNodeId };
const socket = join(process.env.SOCKETS ?? work, "control-tailscaled.sock");
rmSync(socket, { force: true });
const tailscaled = createServer((_, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: ids.laptop } }));
});
await new Promise<void>((resolve) => tailscaled.listen(socket, resolve));

const proxy = createTcpServer((client) => {
  client.on("error", () => {});
  client.once("data", () => {
    client.write(Buffer.from([5, 0]));
    client.once("data", (req: Buffer) => {
      const host = req.subarray(5, 5 + req[4]!).toString();
      const port = req.readUInt16BE(5 + req[4]!);
      appendFileSync(join(work, "connects"), `${host}:${port}\n`);
      const upstream = connect(port, host === "nexus.verify" ? "127.0.0.1" : host, () => {
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        client.pipe(upstream).pipe(client);
      });
      upstream.on("close", () => client.destroy());
      upstream.on("error", () => {});
    });
  });
});
await new Promise<void>((resolve) => proxy.listen(7471, "127.0.0.1", resolve));

const seeded = openRegistry(join(work, "registry.db"));
seeded.saveImage(testImage(), null);
seeded.setCurrentImage(testImage().id);
seeded.close();

const controlPlane = await startControlPlane({
  db: join(work, "registry.db"),
  listen: { host: "127.0.0.1", port: 7470, hostnames: ["127.0.0.1", "localhost", "nexus.verify"] },
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
  process.once(signal, () => void controlPlane.close().then(() => { tailscaled.close(); proxy.close(); process.exit(0); }));
}
console.log(JSON.stringify({ api: controlPlane.port }));
