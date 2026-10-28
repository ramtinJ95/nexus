/**
 * The verify-nexus stack's control plane, without its probe or Docker: the real startControlPlane on
 * 127.0.0.1:7470, behind the stack's fake tailscaled, whose whois names every caller as the person's laptop, and no
 * deployers, as the stack lists none. It drives the real `nexus` shim from a fresh HOME with no NEXUS_URL and prints
 * each command with its output and exit code:
 *   node docs/verification/nexus-connect/capture.ts
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedModel, scriptedModels } from "../../../src/harness/test-fixture.ts";
import { startControlPlane } from "../../../src/control/main.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const dir = await mkdtemp(join(tmpdir(), "nexus-connect-"));
const socket = join(dir, "tailscaled.sock");
const tailscaled = createServer((_, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: "nVERIFYLAPTOP" } })));
await new Promise<void>((resolve) => tailscaled.listen(socket, resolve));
const controlPlane = await startControlPlane({
  db: join(dir, "registry.db"),
  listen: { host: "127.0.0.1", port: 7470, hostnames: ["127.0.0.1", "localhost"] },
  self: { tailnetNodeId: "nVERIFYCONTROL" as TailnetNodeId },
  nodes: [{ name: "verify-node" as NodeName, tailnetHost: "127.0.0.1", tailnetNodeId: "nVERIFYPROBE" as TailnetNodeId }],
  callers: ["nVERIFYLAPTOP" as TailnetNodeId],
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  harness: { storage: join(dir, "harness.sqlite"), credentials: join(dir, "unused-credentials.json"), model: scriptedModel },
  tailscaledSocket: socket,
  previewPorts: { first: 10200, last: 10299 },
  resumeAfterUsageLimit: false,
}, scriptedModels());

const home = join(dir, "home");
const shim = fileURLToPath(new URL("../../../deploy/mac/nexus", import.meta.url));
const shown = (text: string) => text.replaceAll(home, "<home>");
function nexus(...args: string[]): Promise<void> {
  return new Promise((resolve) => execFile(shim, args, { env: { PATH: process.env.PATH!, HOME: home } }, (err, stdout, stderr) => {
    console.log(shown(`$ nexus ${args.join(" ")}\n${stdout}${stderr}[exit ${err === null ? 0 : err.code}]\n`));
    resolve();
  }));
}
await nexus("--version");
await nexus("threads");
await nexus("connect", "127.0.0.1");
console.log(shown(`$ cat <home>/.config/nexus/cli.json\n${await readFile(join(home, ".config", "nexus", "cli.json"), "utf8")}`));
await nexus("project", "add", "spoon", "https://github.com/octocat/Spoon-Knife.git", "--node", "verify-node");
await nexus("projects");
await nexus("threads");
await nexus("threads", "--json");
await controlPlane.close();
tailscaled.close();
await rm(dir, { recursive: true });
