// A local Nexus control plane for the conversation-image captures: the real registry, API and dashboard on
// 127.0.0.1:7470, with three threads that hold screenshots. `worker` is a Claude worker whose transcript is a file in
// Claude Code's record shapes: the person pastes a screenshot, Claude runs a command that writes one, reads another
// back, and names both in its reply. The checkout's own reader reads that file through a stand-in probe, as it reads
// a pylon's. `harness` is a harness conversation whose person sends a screenshot and whose read call returns one.
// `paused` is a second Claude worker on the same transcript whose pylon pauses after its first read, until the driver
// lets it run again. Every thread's checkout is one fixture repository in which one screenshot changed and one was
// added since the pylon booted.
// Stand-ins replace only what this pylon cannot host: whois answers the laptop; the model is the test harness; the
// probe runs the guest's commands here, against the fixture repository and transcript; the node's observation is
// written here. Nothing reaches a pylon or the live control plane. The same file runs on main and on the branch.
//
//   EVIDENCE=<dir> node docs/verification/conversation-images/stack.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { openRegistry, type Thread } from "../../../src/control/registry.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { claudeProjects } from "../../../src/claude-transcript.ts";
import { processStream } from "../../../src/process-stream.ts";
import { checkoutDir } from "../../../src/sessions.ts";
import type { NodeName, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";

const here = import.meta.dirname;
const evidence = process.env.EVIDENCE ?? mkdtempSync(join(tmpdir(), "nexus-images-evidence-"));
mkdirSync(evidence, { recursive: true });
const log = (line: string) => appendFileSync(join(evidence, "stack.log"), `${new Date().toISOString()} ${line}\n`);
const scratch = mkdtempSync(join(tmpdir(), "nexus-images-"));
// Real dashboard captures, from the scrolling fix's before and after.
const captures: Record<string, string> = {
  "pasted.png": "main/phone-14-window-shrank-then-reply.png", "phone-before.png": "main/phone-14-window-shrank-then-reply.png",
  "phone-after.png": "branch/phone-14-window-shrank-then-reply.png", "desktop.png": "branch/desktop-02-long-conversation.png",
  "pipeline-before.png": "main/phone-08-pipeline.png", "pipeline-after.png": "branch/phone-08-pipeline.png",
};
const shot = (name: string) => join(here, "../dashboard-scrolling", captures[name]!);

const repo = join(scratch, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
const put = (path: string, from: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  copyFileSync(from, join(repo, path));
};
mkdirSync(repo);
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "style.css"), ".dock { max-height: 45%; }\n");
put("docs/shots/conversation-phone.png", shot("phone-before.png"));
git("add", "-A");
git("commit", "-q", "-m", "base");
git("update-ref", "refs/nexus/base", "HEAD");
writeFileSync(join(repo, "style.css"), ".dock { max-height: 30%; overflow: auto; }\n");
put("docs/shots/conversation-phone.png", shot("phone-after.png"));
put("docs/shots/conversation-desktop.png", shot("desktop.png"));

const session = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const projects = join(scratch, "projects");
mkdirSync(join(projects, "-home-user-workspace-repo"), { recursive: true });
const base64 = (file: string) => readFileSync(file).toString("base64");
const block = (file: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: base64(file) } });
let at = Date.now() - 20 * 60_000;
const record = (r: Record<string, unknown>) => JSON.stringify({
  parentUuid: null, isSidechain: false, userType: "external", cwd: checkoutDir, sessionId: session, version: "2.1.308", gitBranch: "fix/phone-dock",
  uuid: randomUUID(), timestamp: new Date(at += 9_000).toISOString(), ...r,
});
const said = (content: unknown[]) => record({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "claude-opus-5-5", content } });
const answered = (id: string, content: unknown, extra: Record<string, unknown> = {}) => record({ type: "user", promptId: "p1", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content }] }, ...extra });
const desktop = shot("desktop.png");
writeFileSync(join(projects, "-home-user-workspace-repo", `${session}.jsonl`), [
  record({ type: "user", promptId: "p1", origin: { kind: "human" }, message: { role: "user", content: [
    { type: "text", text: "On a phone the dock covers most of the conversation once the keyboard opens. This is what I see:" },
    block(shot("pasted.png")),
  ] } }),
  said([{ type: "text", text: "I'll capture the thread page at 390 px with the fix, and at the desktop width to check nothing else moved." }, { type: "tool_use", id: "toolu_shot", name: "Bash", input: { command: "node scripts/shot.mjs --width 390 --out docs/shots/conversation-phone.png && node scripts/shot.mjs --width 1280 --out docs/shots/conversation-desktop.png", description: "Capture the thread page" } }]),
  answered("toolu_shot", "Saved docs/shots/conversation-phone.png (390×844)\nSaved docs/shots/conversation-desktop.png (1280×900)"),
  said([{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: `${checkoutDir}/docs/shots/conversation-desktop.png` } }]),
  answered("toolu_read", [block(desktop)], { toolUseResult: { type: "image", file: { base64: base64(desktop), type: "image/png", originalSize: readFileSync(desktop).length } } }),
  said([{ type: "text", text: `The dock now takes at most 30% of the window and scrolls inside, so the conversation keeps most of it. The new captures are \`docs/shots/conversation-phone.png\` and ${checkoutDir}/docs/shots/conversation-desktop.png. I compared against a capture I kept in /tmp/before.png, which is outside the checkout.` }]),
  record({ type: "system", subtype: "turn_duration", durationMs: 41_000 }),
].join("\n") + "\n");

const node = "verify-node" as NodeName;
const laptop = "nVERIFYLAPTOP" as TailnetNodeId;
const registry = openRegistry(join(scratch, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
const fake = fakeHarness();
const startThread = threadStarter({ registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("the capture reads no remote")) } });
const guest = (argv: string[]) => {
  // The checkout helper reads its script from stdin and the checkout from its first argument; a transcript read names
  // Claude's projects folder. Both point at the fixtures here.
  if (argv[0] === "python3" && argv[1] === "-") return processStream(argv[0], [argv[1], repo, ...argv.slice(3)], (text) => process.stderr.write(text));
  if (argv[0] === "sh" && argv[1] === "-c") return processStream("sh", argv.slice(1).map((a) => a === claudeProjects ? projects : a), (text) => process.stderr.write(text));
  throw new Error(`the capture runs no ${argv[0]} in a pylon`);
};
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470,
  deployment: { self: "nNODE" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" },
  harness: fake.harness, startThread, wake: () => log("asked to wake the node"), previewPorts: { first: 10200, last: 10299 },
  probes: new Map([[node, {
    command: async () => { throw new Error("the capture runs no guest commands"); },
    stream: async (pylonId: string, argv: string[]) => {
      log(`${pylonId}: ${argv[0]} ${argv[1]} ${argv[0] === "sh" ? argv.slice(3).join(" ") : argv.slice(3).join(" ")}`);
      return guest(argv);
    },
  }]]),
} as unknown as Parameters<typeof startApi>[0]);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
};

const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
await call("POST", "/v1/projects", {
  id: "nexus", repoUrl: "https://github.com/example/nexus.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
registry.saveImage(image as never, null);
registry.setCurrentImage(image.id as never);

const start = (title: string, claude?: string): Promise<Thread> => call("POST", "/v1/threads", { project: "nexus", title, ...(claude === undefined ? {} : { claude }) });
const prompt = "On a phone the dock covers most of the conversation once the keyboard opens.";
const worker = await start("Keep the conversation in view above the phone's dock", prompt);
const paused = await start("The same transcript, its pylon paused", prompt);
const harness = await start("Let the pipeline's cells wrap on a phone");
for (const t of [worker, paused]) registry.setClaudeWorker(t.id, prompt, "started", undefined, session);

const assistant = (content: AssistantMessage["content"]): Message => ({
  role: "assistant", content, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop", api: "x", provider: "openai", model: "gpt-6-astra", timestamp: at,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const png = (file: string) => ({ type: "image" as const, data: base64(shot(file)), mimeType: "image/png" });
fake.transcript(harness.id).messages.push(
  { role: "user", content: [{ type: "text", text: "The pipeline's cells cut off mid-word on my phone, like this:" }, png("pipeline-before.png")], timestamp: at },
  assistant([{ type: "text", text: "I'll look at the capture of the page with the cells wrapping." }, { type: "toolCall", id: "r1", name: "read", arguments: { path: "docs/shots/conversation-desktop.png" } }]),
  { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, png("pipeline-after.png")], isError: false, timestamp: at, durationMs: 41 } as Message,
  assistant([{ type: "text", text: "Titles and reasons wrap now, and no cell is cut off. The capture is `docs/shots/conversation-desktop.png`." }]),
);
fake.commit(harness.id);

let pausedNow = false;
const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
const observe = () => {
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = [worker, paused, harness].map((t): PylonObservation => t === paused && pausedNow
    ? { pylonId: t.pylonId, phase: "stopped", checkpoint: null, sessions: null } as PylonObservation
    : {
      pylonId: t.pylonId, phase: "running", liveHash: registry.pylon(t.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
      bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
      services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
    } as PylonObservation);
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons, previewRoutes: [] } as never, []);
};
observe();
setInterval(observe, 1000);

// The conversation route reads the transcript before it answers, as a visit to the thread page's API would.
for (const t of [worker, paused]) {
  const view = await call("GET", `/v1/threads/${t.id}/conversation`);
  log(`${t.id}: read ${view.entries.length} entries: ${view.entries.map((e: { kind: string }) => e.kind).join(", ")}`);
}
pausedNow = true;
observe();

// Port 7489 takes a POST to /verify/run, which lets the paused pylon run again, as a wake would, and to
// /verify/pause, which pauses it again.
createServer((req, res) => {
  if (req.method !== "POST" || (req.url !== "/verify/run" && req.url !== "/verify/pause")) return void res.writeHead(404).end();
  pausedNow = req.url === "/verify/pause";
  log(pausedNow ? "the pylon pauses again" : "the paused pylon runs again");
  observe();
  res.writeHead(204).end();
}).listen(7489, "127.0.0.1");

console.log(JSON.stringify({ worker: worker.id, harness: harness.id, paused: paused.id }));
