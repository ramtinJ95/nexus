/**
 * Drives the real `nexus` CLI against the real API of the checkout it runs in, as a person's laptop, as the control
 * node and as an infrastructure node, and prints each command with its exit code and output:
 *   node docs/verification/person-only-thread-starts/capture.ts
 *
 * Only the boundaries are stand-ins: whois names whichever caller the step says, and the harness is a real pi-durable
 * one over the scripted model, with no pylon, as src/control/stream.check.ts runs it.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { scriptedModel, scriptedModels } from "../../../src/harness/test-fixture.ts";
import type { ImageId } from "../../../src/images.ts";
import type { ProjectId } from "../../../src/project.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";
import { startApi, type ThreadHarness } from "../../../src/control/api.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { openRegistry } from "../../../src/control/registry.ts";

const dir = await mkdtemp(join(tmpdir(), "nexus-person-only-"));
const laptop = "nLAPTOP" as TailnetNodeId;
const firebat = "nFIREBAT" as TailnetNodeId;
const testbench = "nTESTBENCH" as TailnetNodeId;
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "harness.sqlite")), { models: scriptedModels(), registry: createRegistry() }, context);
const conversations = new Map<string, ConversationId>();
const conversation = async (threadId: string) => (await harness.conversation(conversations.get(threadId)!, context))!;
const threads: ThreadHarness = {
  latestTurn: async () => null,
  async startThread({ threadId }) {
    const created = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: scriptedModel, cwd: "/" } }, context);
    conversations.set(threadId, created.id);
    return created.id;
  },
  async send(threadId, text, requestId, mode) {
    return (await conversation(threadId)).submit({ type: "input", content: text, requestId, whenBusy: mode }, context);
  },
  async abort(threadId) { await (await conversation(threadId)).abort(context); },
  async retry() {},
  async watch(threadId) { return (await conversation(threadId)).watch(context); },
  async deleteThread({ threadId }) { await (await conversation(threadId)).abort(context); },
  activity: { facts: () => { throw new Error("the API reads agent facts from the registry"); }, parked: () => [] },
};
harness.resume();

const registry = openRegistry(join(dir, "registry.db"));
registry.upsertNode({ name: "rj-firebat" as NodeName, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: firebat });
registry.upsertNode({ name: "infra-testbench" as NodeName, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: testbench });
registry.createProject({
  id: "acme" as ProjectId, repoUrl: null, defaultBranch: "main", defaultNode: "rj-firebat" as NodeName,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
const image = "img-0123456789ab" as ImageId;
registry.saveImage({
  id: image, gondolinBuildId: "b1", builtOn: "rj-firebat" as NodeName, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: { debianDigest: "d", node: "n", nodeSha256: "n", claudeCode: "c", pi: "p", herdr: "h", piEnv: "e", piEnvSha256: "s", gondolin: "g", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64), neovim: "0.12.6", neovimSha256: "b".repeat(64) },
}, null);
registry.setCurrentImage(image);
let caller = laptop;
const api = await startApi({
  registry, host: "127.0.0.1", port: 0, whois: async () => caller, allowed: new Set([laptop, firebat, testbench]), hostnames: new Set(["127.0.0.1"]),
  deployment: { self: firebat, deployers: new Set(), keys: {} },
  harness: threads, wake: () => {},
  startThread: threadStarter({
    registry, harness: threads, wake: () => {}, dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" },
    mirror: { setupInputs: () => Promise.reject(new Error("the capture reads no remote")) },
  }),
  probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});

const cli = fileURLToPath(new URL("../../../src/cli/nexus.ts", import.meta.url));
const nexus = (who: string, id: TailnetNodeId, ...args: string[]) => new Promise<string>((resolve) => {
  caller = id;
  execFile(process.execPath, [cli, ...args], { env: { ...process.env, NEXUS_URL: `http://127.0.0.1:${api.port}`, NEXUS_SOCKS: "none" } }, (err, stdout, stderr) => {
    console.log(`$ nexus ${args.join(" ")}    # as ${who}\nexit ${err?.code ?? 0}\n${stdout}${stderr}`);
    resolve(stdout.trim());
  });
});

try {
  const started = JSON.parse(await nexus("the person's laptop", laptop, "start", "--project", "acme", "--title", "Capture", "--json")) as { id: string };
  await nexus("the person's laptop", laptop, "send", started.id, "hello");
  await nexus("the person's laptop", laptop, "conversation", started.id);
  for (const [who, id] of [["the control node", firebat], ["an infrastructure node", testbench]] as const) {
    await nexus(who, id, "start", "--project", "acme", "--title", `Started by ${who}`);
    await nexus(who, id, "send", started.id, `hello from ${who}`);
  }
  console.log(`threads: ${registry.threads().map((t) => `${t.title} (startedBy ${t.startedBy})`).join(", ")}`);
} finally {
  await api.close();
  registry.close();
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
}
