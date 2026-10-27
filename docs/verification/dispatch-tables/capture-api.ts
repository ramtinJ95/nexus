// Starts the real control-plane API on loopback, as src/control/api.test.ts does, and writes what each client gets
// back: every status, header and body of the health, release, deployer and event routes for each kind of caller, and
// the bytes of event and thread streams, across a deploy drain, a slow client, a stalled client and the streams' limit.
// Run from the root of a checkout: node docs/verification/dispatch-tables/capture-api.ts <out-file>
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// One fixed clock, so the two checkouts store and print the same times.
const now = Date.parse("2026-10-27T12:00:00Z");
Date.now = () => now;

const { maxStreams, startApi } = await import("../../../src/control/api.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { fakeHarness } = await import("../../../src/control/fake-harness.ts");
const { threadStarter } = await import("../../../src/control/threads.ts");
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;
type NodeName = import("../../../src/protocol.ts").NodeName;
type ImageId = import("../../../src/images.ts").ImageId;
type DeploymentOptions = import("../../../src/control/releases.ts").DeploymentOptions;

const out = process.argv[2]!;
const lines: string[] = [];
const log = (line: string) => lines.push(line);
const dir = await mkdtemp(join(tmpdir(), "dispatch-capture-"));

const laptop = "nLAPTOP" as TailnetNodeId;
const firebat = "nFIREBAT" as TailnetNodeId;
const other = "nOTHER" as TailnetNodeId;
const deployCommit = "a".repeat(40);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const deployment: DeploymentOptions = {
  self: firebat, deployers: new Set([laptop, firebat]), keys: { nFIREBAT: hash("root-token"), nOTHER: hash("other-token") }, resolveMain: async () => deployCommit,
};
const project = {
  id: "acme", repoUrl: "https://example.com/acme.git", defaultBranch: "main", defaultNode: "rj-firebat",
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: "rj-firebat", builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};

async function stack(options: { deployment?: DeploymentOptions; streamStallMs?: number } = {}) {
  const registry = openRegistry(join(dir, `${randomUUID()}.db`));
  registry.upsertNode({ name: "rj-firebat" as NodeName, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: firebat });
  registry.upsertNode({ name: "rj-other" as NodeName, tailnetHost: "rj-other.tail.ts.net", tailnetNodeId: other });
  let caller: TailnetNodeId | null = laptop;
  const fake = fakeHarness();
  const mirror = { setupInputs: () => Promise.reject(new Error("no remote")) };
  const startThread = threadStarter({ registry, harness: fake.harness, mirror, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, wake: () => {} });
  const api = await startApi({
    registry, host: "127.0.0.1", port: 0, whois: async () => caller, allowed: new Set([laptop, firebat]),
    ...(options.deployment === undefined ? {} : { deployment: options.deployment }),
    hostnames: new Set(["127.0.0.1"]), harness: fake.harness, startThread, wake: () => {},
    probes: new Map(), previewPorts: { first: 10200, last: 10299 },
    ...(options.streamStallMs === undefined ? {} : { streamStallMs: options.streamStallMs }),
  });
  const host = { host: `127.0.0.1:${api.port}` };
  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingMessage["headers"]; text: string }> {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      request({
        host: "127.0.0.1", port: api.port, method, path,
        headers: { ...host, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }), ...headers },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      }).on("error", reject).end(payload);
    });
  }
  /** A raw stream client: everything it read, whether the server ended or dropped it, and a pause like a slow reader's. */
  function open(path: string) {
    const state = { status: 0, headers: {} as IncomingMessage["headers"], text: "", body: "", ended: "open" as "open" | "end" | "dropped" };
    let res: IncomingMessage | undefined;
    const req = request({ host: "127.0.0.1", port: api.port, path, headers: host });
    req.on("error", () => {});
    req.on("close", () => { if (state.ended === "open") state.ended = "dropped"; });
    const response = new Promise<void>((resolve) => req.on("response", (r: IncomingMessage) => {
      res = r;
      state.status = r.statusCode!;
      state.headers = r.headers;
      r.setEncoding("utf8");
      r.on("data", (chunk: string) => { state.text += chunk; });
      r.on("end", () => { state.ended = "end"; });
      r.on("error", () => {});
      r.on("close", () => { if (state.ended === "open") state.ended = "dropped"; });
      resolve();
    }));
    req.end();
    return { state, response, pause: () => res?.pause(), resume: () => res?.resume(), close: () => req.destroy() };
  }
  return { registry, fake, call, open, callAs(id: TailnetNodeId | null) { caller = id; }, close: async () => { await api.close(); registry.close(); } };
}

async function until(done: () => boolean, what: string) {
  const deadline = performance.now() + 60_000;
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`gave up waiting: ${what}`);
    await sleep(20);
  }
}

/** A stream's frames with only its last ping, since how many pings fall between two events is a matter of timing. */
function framing(text: string) {
  const blocks = text.split("\n\n").filter((block) => block !== "");
  return blocks.filter((block, i) => !block.endsWith(": ping") || i === blocks.length - 1).join("\n\n") + "\n\n";
}

const reply = (r: { status: number; headers: IncomingMessage["headers"]; text: string }) =>
  `${r.status} content-type=${r.headers["content-type"]} cache-control=${r.headers["cache-control"]} ${r.text}`;

log("# Routes, by caller");
{
  const off = await stack();
  const on = await stack({ deployment });
  const notDeployer = await stack({ deployment: { ...deployment, deployers: new Set([firebat]) } });
  const report = { role: "probe", commit: deployCommit, target: deployCommit, state: "healthy", reason: null };
  const callers: [string, Awaited<ReturnType<typeof stack>>, TailnetNodeId | null, Record<string, string>][] = [
    ["a deployer", on, laptop, {}],
    ["an allowed caller who is not a deployer", notDeployer, laptop, {}],
    ["an allowed caller while deploys are off", off, laptop, {}],
    ["the control node", on, firebat, {}],
    ["the control node with its deployer key", on, firebat, { authorization: "Bearer root-token" }],
    ["the control node with another key", on, firebat, { authorization: "Bearer not-the-key" }],
    ["an allowed laptop with the control node's key", on, laptop, { authorization: "Bearer root-token" }],
    ["another node with its deployer key", on, other, { authorization: "Bearer other-token" }],
    ["a stranger", on, "nSTRANGER" as TailnetNodeId, {}],
    ["a caller tailscaled does not know", on, null, {}],
  ];
  const requests: [string, string, unknown?, Record<string, string>?][] = [
    ["GET", "/v1/health?past=admission"],
    ["HEAD", "/v1/health?past=admission"],
    ["POST", "/v1/health", {}],
    ["GET", "/v1/release"],
    ["PUT", "/v1/release", { commit: "main" }],
    ["PUT", "/v1/release", { commit: deployCommit }],
    ["PUT", "/v1/release", { commit: "--evil" }],
    ["PUT", "/v1/release", { commit: "main", extra: 1 }],
    ["PUT", "/v1/release", "{not json"],
    ["PUT", "/v1/release", { commit: "main" }, { "content-type": "text/plain" }],
    ["POST", "/v1/release", { commit: "main" }],
    ["DELETE", "/v1/release"],
    ["GET", "/v1/release/x"],
    ["GET", "/v1/deployer/release"],
    ["POST", "/v1/deployer/release", {}],
    ["POST", "/v1/deployer/report", report],
    ["POST", "/v1/deployer/report", { ...report, role: "control" }],
    ["POST", "/v1/deployer/report", { ...report, state: "fine" }],
    ["GET", "/v1/deployer/report"],
    ["POST", "/v1/deployer/drain", { commit: "b".repeat(40) }],
    ["POST", "/v1/deployer/drain", { commit: deployCommit }],
    ["PUT", "/v1/release", { commit: deployCommit }],
    ["POST", "/v1/deployer/drain", { commit: deployCommit, hold: true }],
    ["POST", "/v1/deployer/drain", { commit: deployCommit, release: true }],
    ["POST", "/v1/deployer/drain", { commit: deployCommit, extra: 1 }],
    ["GET", "/v1/deployer/drain"],
    ["POST", "/v1/deployer/nothing", {}],
    ["GET", "/v1/deployer/nothing"],
    ["GET", "/v1/deployer"],
    ["GET", "/v1/%64eployer/release"],
    ["GET", "/v1/events"],
    ["GET", "/v1/events?kind=release.changed&since=1"],
    ["GET", "/v1/events?since=-1"],
    ["GET", "/v1/events?kind=unknown"],
    ["GET", "/v1/events?thread=th-x&project=acme"],
    ["DELETE", "/v1/events"],
    ["GET", "/v1/events/x"],
  ];
  for (const [who, s, id, headers] of callers) {
    log(`## ${who}`);
    s.callAs(id);
    for (const [method, path, body, extra] of requests) {
      const r = await s.call(method, path, body, { ...headers, ...extra });
      log(`${method} ${path}${extra ? ` ${JSON.stringify(extra)}` : ""} -> ${reply(r)}`);
    }
  }
  for (const s of [off, on, notDeployer]) await s.close();
}

log("");
log("# An event follower's bytes");
{
  const s = await stack();
  s.registry.appendEvent("release.changed", null, { state: "pending" });
  s.registry.appendEvent("thread.failed", null, {});
  const follower = s.open("/v1/events?follow=true&kind=release.changed");
  await follower.response;
  log(`status ${follower.state.status} content-type=${follower.state.headers["content-type"]} cache-control=${follower.state.headers["cache-control"]}`);
  await until(() => follower.state.text.split(": ping").length > 3, "three pings");
  s.registry.appendEvent("release.changed", null, { state: "installing" });
  s.registry.appendEvent("thread.failed", null, {});
  s.registry.appendEvent("release.changed", null, { state: "healthy" });
  await until(() => follower.state.text.includes('"healthy"') && follower.state.text.endsWith("\n: ping\n\n"), "the next batch");
  const cut = follower.state.text;
  log(`first frames, raw: ${JSON.stringify(cut.split(/(?<=\n\n)/).slice(0, 3))}`);
  log(`every frame, with only the last ping: ${JSON.stringify(framing(cut))}`);
  const started = performance.now();
  const pings = cut.split(": ping").length - 1;
  await until(() => follower.state.text.split(": ping").length - 1 >= pings + 2, "two more pings");
  log(`two more pings took about ${Math.round((performance.now() - started) / 1000)} s`);
  follower.close();
  await s.close();
}

log("");
log("# An event follower open across a deploy drain");
{
  const s = await stack({ deployment });
  const follower = s.open("/v1/events?follow=true");
  const filtered = s.open("/v1/events?follow=true&kind=release.changed&since=0");
  await Promise.all([follower.response, filtered.response]);
  const root = { authorization: "Bearer root-token" };
  const step = async (what: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await s.call(method, path, body, headers);
    log(`${what}: ${method} ${path} -> ${r.status} ${r.text}`);
  };
  await step("deployer asks for a release", "PUT", "/v1/release", { commit: deployCommit });
  s.callAs(firebat);
  await step("control reports", "POST", "/v1/deployer/report", { role: "control", commit: null, target: deployCommit, state: "waiting-for-idle", reason: null }, root);
  await step("control drains", "POST", "/v1/deployer/drain", { commit: deployCommit }, root);
  await step("control holds", "POST", "/v1/deployer/drain", { commit: deployCommit, hold: true }, root);
  s.callAs(laptop);
  await step("a start during the drain", "POST", "/v1/threads", { project: "acme", title: "t" });
  const during = s.open("/v1/events?follow=true&kind=release.changed");
  await during.response;
  s.callAs(firebat);
  await step("control reports", "POST", "/v1/deployer/report", { role: "control", commit: deployCommit, target: deployCommit, state: "installing", reason: null }, root);
  await step("control releases the drain", "POST", "/v1/deployer/drain", { commit: deployCommit, release: true }, root);
  await step("control reports", "POST", "/v1/deployer/report", { role: "control", commit: deployCommit, target: deployCommit, state: "healthy", reason: null }, root);
  s.registry.appendEvent("thread.failed", null, { after: "drain" });
  await until(() => follower.state.text.includes('"after":"drain"') && follower.state.text.endsWith(": ping\n\n"), "the follower caught up");
  await until(() => during.state.text.includes('"healthy"') && during.state.text.endsWith(": ping\n\n"), "the follower opened during the drain caught up");
  await sleep(1_200);
  log(`follower ${follower.state.status} ${follower.state.ended}: ${JSON.stringify(framing(follower.state.text))}`);
  log(`filtered ${filtered.state.status} ${filtered.state.ended}: ${JSON.stringify(framing(filtered.state.text))}`);
  log(`opened during the drain ${during.state.status} ${during.state.ended}: ${JSON.stringify(framing(during.state.text))}`);
  for (const c of [follower, filtered, during]) c.close();
  await s.close();
}

log("");
log("# A slow event follower, and one that stops reading");
{
  const s = await stack({ streamStallMs: 1000 });
  const slow = s.open("/v1/events?follow=true&kind=release.changed");
  await slow.response;
  slow.pause();
  const ids: string[] = [];
  for (let n = 1; n <= 12; n++) ids.push(s.registry.appendEvent("release.changed", null, { n, pad: "x".repeat(1 << 20) }).id);
  await sleep(1_500);
  slow.resume();
  await until(() => slow.state.text.includes(`id: ${ids.at(-1)}\ndata:`) && slow.state.text.endsWith(": ping\n\n"), "the slow follower caught up");
  const received = [...slow.state.text.matchAll(/^id: (\d+)\ndata: /gm)].map((m) => m[1]);
  log(`slow follower ${slow.state.ended}: events ${received.join(",")}; each once in order: ${JSON.stringify(received) === JSON.stringify(ids)}`);
  log(`slow follower framing without data: ${JSON.stringify(framing(slow.state.text.replace(/^data: .*$/gm, "data: …")))}`);

  const stalled = s.open("/v1/events?follow=true");
  await stalled.response;
  stalled.pause();
  const others = Array.from({ length: maxStreams - 2 }, () => s.open("/v1/events?follow=true&kind=release.changed"));
  await Promise.all(others.map((o) => o.response));
  log(`one past the limit: ${reply(await s.call("GET", "/v1/events?follow=true"))}`);
  for (let n = 0; n < 24; n++) s.registry.appendEvent("thread.failed", null, { n, pad: "x".repeat(1 << 20) });
  let freed = s.open("/v1/events?follow=true&kind=release.changed");
  await freed.response;
  let tries = 0;
  while (freed.state.status === 503) {
    tries++;
    await sleep(100);
    freed = s.open("/v1/events?follow=true&kind=release.changed");
    await freed.response;
  }
  log(`a place came free once the stalled follower was dropped: ${freed.state.status}, after ${tries > 5 ? "more than half a second" : "under half a second"}`);
  stalled.resume();
  await until(() => stalled.state.ended !== "open", "the stalled follower ended");
  log(`stalled follower: ${stalled.state.ended}`);
  for (const c of [slow, freed, ...others]) c.close();
  await s.close();
}

log("");
log("# Thread streams, their limit and a delete");
{
  const s = await stack();
  await s.call("POST", "/v1/projects", project);
  await s.call("POST", "/v1/images", image);
  s.registry.setCurrentImage(image.id as ImageId);
  const started = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Fix checkout" })).text);
  const id = started.id as string;
  const scrub = (text: string) => text.replaceAll(id, "<thread>");
  const view = s.open(`/v1/threads/${id}/events`);
  const page = s.open(`/threads/${id}/stream`);
  await Promise.all([view.response, page.response]);
  await until(() => view.state.text.endsWith("\n\n") && page.state.text.endsWith("\n\n"), "the first frames");
  log(`view stream ${view.state.status} content-type=${view.state.headers["content-type"]} cache-control=${view.state.headers["cache-control"]}`);
  const transcript = s.fake.transcript(id);
  transcript.docs["pi.live"] = { seq: 1 };
  s.fake.commit(id);
  await until(() => view.state.text.split("\n\n").length > 2, "a commit's frame");
  const before = view.state.text.length;
  const started15 = performance.now();
  await until(() => view.state.text.length > before, "a ping");
  log(`the next write after ${Math.round((performance.now() - started15) / 1000)} s`);
  log(`view stream: ${scrub(JSON.stringify(view.state.text.replace(/"(createdAt|updatedAt|at|time|startedAt)":\d+/g, '"$1":0')))}`);
  log(`page stream frames: ${page.state.text.split("\n\n").length - 1}, ends in a ping: ${page.state.text.endsWith(": ping\n\n")}`);
  log(`POST to a stream: ${scrub(reply(await s.call("POST", `/v1/threads/${id}/events`, {})))}`);
  log(`an unknown thread's stream: ${reply(await s.call("GET", "/v1/threads/th-missing/events"))}`);
  log(`a Claude stream of a harness thread: ${scrub(reply(await s.call("GET", `/v1/threads/${id}/claude/events`)))}`);
  const followers = Array.from({ length: maxStreams - 2 }, () => s.open("/v1/events?follow=true"));
  await Promise.all(followers.map((f) => f.response));
  log(`with ${maxStreams} open, a thread stream: ${reply(await s.call("GET", `/v1/threads/${id}/events`))}`);
  log(`with ${maxStreams} open, a follower: ${reply(await s.call("GET", "/v1/events?follow=true"))}`);
  log(`with ${maxStreams} open, a bad cursor: ${reply(await s.call("GET", "/v1/events?follow=true&since=x"))}`);
  log(`with ${maxStreams} open, a plain read: ${reply(await s.call("GET", "/v1/events?since=999999"))}`);
  log(`delete: ${(await s.call("DELETE", `/v1/threads/${id}`)).status}`);
  await until(() => view.state.ended !== "open" && page.state.ended !== "open", "the thread's streams ended");
  log(`after the delete: view stream ${view.state.ended}, page stream ${page.state.ended}, followers open ${followers.filter((f) => f.state.ended === "open").length}`);
  const after = s.open("/v1/events?follow=true");
  await after.response;
  log(`a follower after the delete: ${after.state.status}`);
  log(`a deleted thread's stream: ${scrub(reply(await s.call("GET", `/v1/threads/${id}/events`)))}`);
  for (const c of [after, ...followers]) c.close();
  await s.close();
}

await rm(dir, { recursive: true });
await writeFile(out, lines.join("\n") + "\n");
process.exit(0);
