/**
 * Local validation that an answer streams from pi-durable to `nexus watch --json` and to the thread page as it is
 * written, run by hand on a machine that may listen on loopback:
 *   node src/control/stream.check.ts [seconds the answer takes, default 4]
 *
 * It opens a real pi-durable harness, without an environment, over the scripted model that writes one word every
 * 20 ms, behind the real API. It sends the thread a message and follows it with the CLI's watch and the dashboard's
 * stream, timing every event. The answer must reach the watch as live events several times a second, each one a
 * longer snapshot, and its entry must come before the live event that drops the partial. It prints the timings and
 * STREAM_CHECK_PASS last.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { scriptedModel, scriptedModels, streamedAnswer, streamedWordMs } from "../harness/test-fixture.ts";
import type { ImageId } from "../images.ts";
import type { ProjectId } from "../project.ts";
import type { NodeName, TailnetNodeId } from "../ids.ts";
import { testImage } from "../test-kit.ts";
import { startApi } from "./api.ts";
import type { ThreadHarness } from "./thread-agent.ts";
import { threadStarter } from "./threads.ts";
import { readEvents } from "./event-reader.ts";
import { openRegistry } from "./registry.ts";

const seconds = Number(process.argv[2] ?? 4);
const words = Math.round((seconds * 1000) / streamedWordMs);
const answer = streamedAnswer(words);

const dir = await mkdtemp(join(tmpdir(), "nexus-stream-check-"));
const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
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
  activity: { facts: () => assert.fail("the API reads agent facts from the registry"), parked: () => [] },
};
harness.resume();

const registry = openRegistry(join(dir, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
registry.createProject({
  id: "acme" as ProjectId, repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
const image = "img-0123456789ab" as ImageId;
registry.saveImage(testImage({ id: image }), null);

registry.setCurrentImage(image);
const api = await startApi({
  registry, host: "127.0.0.1", port: 0, whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set(), keys: {} },
  harness: threads, wake: () => {},
  startThread: threadStarter({
    registry, harness: threads, wake: () => {}, dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" },
    mirror: { setupInputs: () => Promise.reject(new Error("the stream check reads no remote")) },
  }),
  probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});
const url = `http://127.0.0.1:${api.port}`;
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  assert.ok(res.ok, `POST ${path} answered ${res.status}: ${text}`);
  return JSON.parse(text) as { id: string };
};

try {
  const thread = await post("/v1/threads", { project: "acme", title: "Stream check" });
  const cli = fileURLToPath(new URL("../cli/nexus.ts", import.meta.url));
  const watch = spawn(process.execPath, [cli, "watch", thread.id, "--json", "--url", url, "--socks", "none"], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: watch.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.ok(!line.done, "the watch ended early");
    return { at: performance.now(), event: JSON.parse(line.value) };
  };
  assert.equal((await next()).event.type, "reset");
  assert.equal((await next()).event.type, "state");
  assert.equal((await next()).event.type, "live");

  const page = readEvents(api.port, `/threads/${thread.id}/stream`);
  assert.ok((await page.next()).convo !== undefined);
  const sent = performance.now();
  await post(`/v1/threads/${thread.id}/messages`, { text: `stream: ${words}`, requestId: "msg:stream-check" });

  const lives: { at: number; length: number }[] = [];
  let entry: { at: number; text: string } | null = null;
  for (;;) {
    const { at, event } = await next();
    if (event.type === "entry" && event.entry.kind === "pi.assistant") entry = { at, text: event.text };
    if (event.type !== "live") continue;
    if (event.partial === null) {
      if (lives.length > 0) {
        assert.ok(entry !== null, "the answer's entry came before the live event that dropped its partial");
        break;
      }
      continue;
    }
    assert.equal(entry, null, "no partial after the answer's entry");
    assert.ok(answer.startsWith(event.partial), "each partial is a prefix of the answer");
    assert.ok(event.partial.length > (lives.at(-1)?.length ?? 0), "each partial is longer than the one before");
    lives.push({ at, length: event.partial.length });
  }
  watch.kill();
  assert.equal(entry!.text, answer);

  let grows = 0;
  for (;;) {
    const frame = await page.next();
    if (frame.grow !== undefined) grows++;
    else if (!frame.convo.includes("data-grow") && frame.convo.includes(`word${words - 1}`)) break;
  }
  page.close();

  const span = (lives.at(-1)!.at - lives[0]!.at) / 1000;
  const gaps = lives.slice(1).map((l, i) => l.at - lives[i]!.at);
  const rate = (lives.length - 1) / span;
  console.log(`answer of ${words} words over ${seconds} s`);
  console.log(`first live event ${Math.round(lives[0]!.at - sent)} ms after the send`);
  console.log(`${lives.length} live events over ${span.toFixed(2)} s, ${rate.toFixed(1)} per second`);
  console.log(`gaps between live events: median ${Math.round(gaps.toSorted((a, b) => a - b)[gaps.length >> 1]!)} ms, max ${Math.round(Math.max(...gaps))} ms`);
  console.log(`entry ${Math.round(entry!.at - lives.at(-1)!.at)} ms after the last live event`);
  console.log(`${grows} grow frames on the thread page's stream`);
  assert.ok(rate >= 3, "several live events a second");
  assert.ok(Math.max(...gaps) < 1000, "no gap of a poll's length");
  assert.ok(grows >= seconds * 3, "the thread page's answer grew in place several times a second");
  console.log("STREAM_CHECK_PASS");
} finally {
  await api.close();
  await harness.close(context);
  registry.close();
  await rm(dir, { recursive: true });
}
