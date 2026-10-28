// Starts the real control-plane API on loopback, as src/control/api.test.ts does, with a fake probe for the thread's
// node, and writes what clients see of session harnesses: each POST /v1/threads/<id>/sessions body's status and reply
// with the command the probe got, each close of a listed session, the JSON sessions list and the dashboard's sessions
// section for sessions of every harness in every state, and the nexus CLI's help and session commands against it.
// Run from the root of a checkout: node docs/verification/harness-registry/capture-api.ts <out-file>
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json, normaliser } from "./normalise.ts";

// One fixed clock, so the two checkouts store and print the same times.
const now = Date.parse("2026-10-27T12:00:00Z");
Date.now = () => now;

const { startApi } = await import("../../../src/control/api.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { fakeHarness } = await import("../../../src/control/fake-harness.ts");
const { threadStarter } = await import("../../../src/control/threads.ts");
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;
type NodeName = import("../../../src/protocol.ts").NodeName;
type PylonCommand = import("../../../src/protocol.ts").PylonCommand;
type CommandResult = import("../../../src/protocol.ts").CommandResult;
type ImageId = import("../../../src/images.ts").ImageId;
type Thread = import("../../../src/control/registry.ts").Thread;
type SessionRow = import("../../../src/reconcile.ts").SessionRow;

const out = process.argv[2]!;
const lines: string[] = [];
const log = (line: string) => lines.push(line);
const dir = await mkdtemp(join(tmpdir(), "harness-capture-"));

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const project = {
  id: "acme", repoUrl: "https://example.com/acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};

const registry = openRegistry(join(dir, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
const fake = fakeHarness();
const commands: PylonCommand[] = [];
let answer = async (command: PylonCommand): Promise<CommandResult> => {
  if (command.kind === "open-session") return { kind: "open-session", herdrPane: "w1:p1" };
  if (command.kind === "close-session") return { kind: "close-session", outcome: "closed" };
  if (command.kind === "drop-failed-session") return { kind: "drop-failed-session", dropped: true };
  throw new Error(`unexpected ${command.kind} command`);
};
const startThread = threadStarter({
  registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  mirror: { setupInputs: () => Promise.reject(new Error("no remote")) },
});
const api = await startApi({
  registry, host: "127.0.0.1", port: 0, whois: async () => laptop, allowed: new Set([laptop]),
  hostnames: new Set(["127.0.0.1"]), harness: fake.harness, startThread, wake: () => {},
  probes: new Map([[node, {
    command: (_pylonId: unknown, command: PylonCommand) => { commands.push(command); return answer(command); },
    stream: () => Promise.reject(new Error("no streams")),
  }]]) as never,
  previewPorts: { first: 10200, last: 10299 },
});

function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    request({
      host: "127.0.0.1", port: api.port, method, path,
      headers: { host: `127.0.0.1:${api.port}`, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, text }));
    }).on("error", reject).end(payload);
  });
}

async function startedThread(title: string): Promise<Thread> {
  const started = await call("POST", "/v1/threads", { project: "acme", title });
  if (started.status !== 201) throw new Error(`starting a thread: ${started.status} ${started.text}`);
  return JSON.parse(started.text) as Thread;
}

if ((await call("POST", "/v1/projects", project)).status !== 201) throw new Error("the project was refused");
if ((await call("POST", "/v1/images", image)).status !== 201) throw new Error("the image was refused");
registry.setCurrentImage(image.id as ImageId);
const thread = await startedThread("Sessions");
const scrubbers: [string, string][] = [];
const scrub = (text: string) => scrubbers.reduce((t, [from, to]) => t.replaceAll(from, to), text).replaceAll(`127.0.0.1:${api.port}`, "127.0.0.1:<port>");
const scrubbed = (t: Thread, name: string) => scrubbers.push([t.pylonId, `<${name} pylon>`], [t.id, `<${name}>`]);
scrubbed(thread, "thread");

log("# POST /v1/threads/<thread>/sessions, and the command the node's probe got");
for (const body of [
  {}, { harness: "claude-code" }, { harness: "pi" }, { harness: "shell" },
  { harness: "claude-code", title: " review " }, { harness: "pi", title: "plan" }, { harness: "shell", title: "sh" }, { title: "only a title" },
  { harness: "codex" }, { harness: "toString" }, { harness: "Claude Code" }, { harness: "" }, { harness: 42 }, { harness: null }, { harness: ["pi"] },
  { resume: "bd2c2d6b" }, { harness: "pi", resume: "/s.jsonl" }, { harness: "claude-code", model: "opus" }, { harness: "claude-code", prompt: "work" },
  { title: "" }, { title: "x".repeat(80) }, { title: "x".repeat(81) }, { harness: "pi", title: 42 },
]) {
  commands.length = 0;
  const res = await call("POST", `/v1/threads/${thread.id}/sessions`, body);
  log(scrub(`${json(body)} => ${res.status} ${res.text} probe got ${json(commands)}`));
}
commands.length = 0;
answer = async () => { throw Object.assign(new Error("rj-firebat: pylon is stopped, not running"), { code: "not-running" }); };
for (const harness of ["claude-code", "pi", "shell"]) {
  const res = await call("POST", `/v1/threads/${thread.id}/sessions`, { harness });
  log(scrub(`${json({ harness })} to a pylon that is not running => ${res.status} ${res.text} probe got ${json(commands.splice(0))}`));
}
answer = async (command) => command.kind === "close-session" ? { kind: "close-session", outcome: "closed" } : command.kind === "drop-failed-session" ? { kind: "drop-failed-session", dropped: true } : { kind: "open-session", herdrPane: "w1:p1" };

const harnesses = ["claude-code", "pi", "shell"] as const;
const statuses = ["working", "idle", "blocked", "done", "unknown"] as const;
let pane = 0;
const rows: SessionRow[] = [
  ...harnesses.flatMap((harness) => statuses.map((status): SessionRow => {
    const id = `w${++pane}:p1`;
    return { id, state: "running", herdrPane: id, harness, harnessSessionId: harness === "shell" ? null : `${harness}-${status}`, title: status === "unknown" ? null : `${harness} ${status}`, status, message: null };
  })),
  ...harnesses.map((harness): SessionRow => {
    const id = `w${++pane}:p1`;
    return { id, state: "paused", herdrPane: id, harness, harnessSessionId: harness === "shell" ? null : `${harness}-paused`, title: `${harness} paused`, status: null, message: null };
  }),
  ...harnesses.map((harness): SessionRow => ({ id: `failed-${harness}`, state: "failed", herdrPane: null, harness, harnessSessionId: null, title: `${harness} failed`, status: null, message: `${harness} did not start` })),
  ...harnesses.map((harness): SessionRow => {
    const id = `w${++pane}:p1`;
    return { id, state: "failed", herdrPane: id, harness, harnessSessionId: harness === "shell" ? null : `${harness}-failed`, title: `${harness} failed in a pane`, status: null, message: `${harness} exited 1` };
  }),
];

/** The inspector section headed by the element with this id, as src/control/dashboard.test.ts reads it. */
function sectionOf(html: string, headingId: string): string {
  const section = html.split("<section").find((chunk) => chunk.includes(`aria-labelledby="${headingId}"`));
  if (section === undefined) return `(no section for ${headingId})`;
  return `<section${section.split("</section>")[0]!}`;
}
/** The page as a reader sees it: tags dropped, entities decoded, whitespace collapsed. */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

async function views(t: Thread, when: string) {
  const detail = await call("GET", `/v1/threads/${t.id}`);
  log("");
  log(`# GET /v1/threads/<thread>, ${when}: ${detail.status}, its sessions`);
  for (const s of (JSON.parse(detail.text) as { sessions: unknown[] }).sessions) log(scrub(json(s)));
  const page = await call("GET", `/threads/${t.id}`);
  const section = sectionOf(page.text, "sessions-h");
  log("");
  log(`# GET /threads/<thread>, ${when}: ${page.status}, its sessions section as a reader sees it, a line per session`);
  for (const part of section.split("<li>")) log(scrub(textOf(part)));
  log("");
  log(`# GET /threads/<thread>, ${when}: its sessions section's HTML`);
  for (const line of section.split("\n")) log(scrub(line));
}

registry.apply({ record: "sessions", pylonId: thread.pylonId, sessions: rows });
await views(thread, "a session of every harness in every state");

const nexus = (args: readonly string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
  execFile(process.execPath, ["--no-warnings", "src/cli/nexus.ts", ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent/nexus-capture-home", ...env } }, (err, stdout, stderr) => {
    resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr });
  });
});
const toApi = { NEXUS_URL: `http://127.0.0.1:${api.port}`, NEXUS_SOCKS: "none" };
const cliRun = async (args: readonly string[], env: Record<string, string>, pick: (stdout: string) => string = (s) => s) => {
  commands.length = 0;
  const r = await nexus(args, env);
  log("");
  log(scrub(`$ nexus ${args.join(" ")} => exit ${r.code}, probe got ${json(commands)}`));
  for (const line of pick(r.stdout).split("\n").filter((l, i, all) => l !== "" || i < all.length - 1)) log(scrub(`stdout: ${line}`));
  for (const line of r.stderr.split("\n").filter((l) => l !== "")) log(scrub(`stderr: ${line}`));
};

log("");
log("# the nexus CLI, as a process, against this API");
await cliRun(["--help"], {});
await cliRun(["session", "open", "--help"], {});
await cliRun(["session", "close", "--help"], {});
await cliRun(["show", thread.id], toApi, (stdout) => stdout.split("\n").filter((l) => l.startsWith("session: ")).join("\n"));
for (const args of [[], ["--harness", "claude-code"], ["--harness", "pi", "--title", "plan"], ["--harness", "shell"], ["--harness", "pi", "--json"], ["--harness", "codex"], ["--harness", "codex", "--json"], ["--harness", ""], ["--title", "x".repeat(81)]]) {
  await cliRun(["session", "open", thread.id, ...args], toApi);
}
await cliRun(["session", "open"], toApi);

const archived = await call("POST", `/v1/threads/${thread.id}/archive`);
log("");
log(`# POST /v1/threads/<thread>/archive => ${archived.status}`);
await views(thread, "the thread archived");
await cliRun(["show", thread.id], toApi, (stdout) => stdout.split("\n").filter((l) => l.startsWith("session: ")).join("\n"));

const closing = await startedThread("Closing");
scrubbed(closing, "closing thread");
registry.apply({ record: "sessions", pylonId: closing.pylonId, sessions: rows });
log("");
log("# DELETE /v1/threads/<closing thread>/sessions/<id> of each listed session, and the command the node's probe got");
for (const outcome of ["closed", "moved", "not-open"] as const) {
  answer = async (command) => command.kind === "close-session" ? { kind: "close-session", outcome } : { kind: "drop-failed-session", dropped: outcome === "closed" };
  for (const row of rows.filter((r) => r.state !== "running" || r.status === "idle")) {
    commands.length = 0;
    const res = await call("DELETE", `/v1/threads/${closing.id}/sessions/${encodeURIComponent(row.id)}`, {});
    log(scrub(`probe answers ${outcome}: ${row.harness} ${row.state} ${row.id} => ${res.status} ${res.text} probe got ${json(commands)}`));
  }
}

await api.close();
registry.close();
await rm(dir, { recursive: true });
const norm = normaliser();
await writeFile(out, lines.map(norm).join("\n") + "\n");
process.exit(0);
