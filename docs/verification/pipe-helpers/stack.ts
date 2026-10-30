/**
 * Drives the four raw-pipe readers through a real probe server and the control plane's real probe client, with a
 * guest that runs each stream as a local process. Run from a worktree's root: node docs/verification/pipe-helpers/stack.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProbe } from "../../../src/probe/server.ts";
import { nodeSecrets } from "../../../src/probe/config.ts";
import { connectProbe, type NodeName, type PylonId, type TailnetNodeId } from "../../../src/protocol.ts";
import { processStream } from "../../../src/process-stream.ts";
import type { Guest, VmBackend } from "../../../src/backend.ts";
import { readAgentUsage } from "../../../src/agent-usage.ts";
import { checkoutReader } from "../../../src/checkout-files.ts";
import { readTranscript, transcriptStart } from "../../../src/claude-transcript.ts";
import { openTerminal, terminalSize } from "../../../src/guest-terminal.ts";

const node = "verify-node" as NodeName;
const controlPlane = "nCONTROL" as TailnetNodeId;
const probeId = "nPROBE" as TailnetNodeId;
const pylonId = "pylon-verify" as PylonId;
const requests: number[] = [];
const guest = { stream: async (argv: readonly string[], log: (text: string) => void) => processStream(argv[0]!, argv.slice(1), log) } as Partial<Guest> as Guest;
const backend = {
  list: async () => [{ pylonId, vm: "running", checkpoint: null, image: "img-000000000000", bootedAt: "2027-01-01T00:00:00Z" }],
  state: async () => "running",
  guest: () => guest,
  artifacts: { list: async () => [] },
} as Partial<VmBackend> as VmBackend;
const probe = await startProbe({
  node, host: "127.0.0.1", port: 0, auth: { controlPlane, peers: [] }, whois: async () => controlPlane, backend,
  secrets: nodeSecrets({ value: () => undefined, names: () => [] }), log: () => undefined,
});
const client = connectProbe(node, "127.0.0.1", probeId, { port: probe.port, whois: async () => probeId });
const open = (argv: readonly string[]) => {
  requests.push(encodeURIComponent(JSON.stringify({ argv })).length);
  return client.stream(pylonId, argv);
};
const fixtures = new URL("../../../src/fixtures/", import.meta.url);
const home = mkdtempSync(join(tmpdir(), "pipe-helpers-"));
const logs = { claude: join(home, "claude"), pi: join(home, "pi") };
const session = "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30";
mkdirSync(join(logs.claude, "-repo"), { recursive: true });
mkdirSync(join(logs.pi, "--repo--"), { recursive: true });
copyFileSync(new URL("claude-transcript.jsonl", fixtures), join(logs.claude, "-repo", `${session}.jsonl`));
copyFileSync(new URL("pi-session.jsonl", fixtures), join(logs.pi, "--repo--", "s.jsonl"));
const repo = join(home, "repo");
mkdirSync(repo);
writeFileSync(join(repo, "app.txt"), "one\n");
execFileSync("git", ["-C", repo, "init", "-q"]);

async function step(name: string, run: () => Promise<string>) {
  const before = requests.length;
  try {
    console.log(`${name}: ${await run()}`);
  } catch (err) {
    console.log(`${name}: FAILED ${(err as Error).message.replace(/\?request=\S+/, "?request=…")}`);
  }
  console.log(`  request URL query bytes: ${requests.slice(before).join(", ")}`);
}

await step("usage", async () => {
  const read = await readAgentUsage(open, new Map(), logs);
  return `${read.calls.length} calls, ${read.calls.filter((c) => c.agent === "claude").length} of them Claude's`;
});
await step("checkout list", async () => JSON.stringify((await checkoutReader(open, repo).list("")).entries));
await step("transcript", async () => `${(await readTranscript(open, session, transcriptStart, logs.claude))!.entries.length} entries`);
await step("terminal paste", async () => {
  const paste = randomBytes(300 << 10);
  const reader = `import hashlib, os, time, tty\ntty.setraw(0)\nos.write(1, b"ready")\ntime.sleep(0.5)\nh, n = hashlib.sha256(), 0\nwhile n < ${paste.length}:\n    b = os.read(0, 65536)\n    h.update(b)\n    n += len(b)\nos.write(1, h.hexdigest().encode())`;
  const terminal = await openTerminal(open, terminalSize(100, 30), "xterm", ["python3", "-c", reader]);
  const chunks: Uint8Array[] = [];
  const out = (async () => { for await (const c of terminal) chunks.push(c); })();
  while (!Buffer.concat(chunks).toString().includes("ready")) await new Promise((r) => setTimeout(r, 20));
  for (let at = 0; at < paste.length; at += 64 << 10) await terminal.write(paste.subarray(at, at + (64 << 10)));
  await out;
  const sent = createHash("sha256").update(paste).digest("hex");
  const got = Buffer.concat(chunks).toString().replace("ready", "");
  return `${paste.length} bytes, ${got === sent ? "same SHA-256 as sent" : `SHA-256 differs: ${got}`}, ${JSON.stringify(await terminal.done)}`;
});
await probe.close();
