/** Pylon routes: previews, sessions, and a checkout's files, changes and images. */
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadDetail } from "./wire.ts";
import { ingest } from "../reconcile.ts";
import { processStream } from "../process-stream.ts";
import { repoInitCommand } from "../pylon-vm-backend.ts";
import { focusScript } from "../sessions.ts";
import { checkoutDir } from "../session-harness.ts";
import { stoppedPylon, tempDir, testCapacity, testObservation } from "../test-kit.ts";
import type { TailnetNodeId } from "../ids.ts";
import type { PausedSession, ServiceFact } from "../protocol/observations.ts";
import { node, laptop, withThread, observeRunning, git, localCheckout, pngBytes } from "./api-test-kit.ts";

test("thread detail lists the pylon's listening ports with the service and preview of each", async (t) => {
  const s = await withThread(t);
  const ports = async () => ((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports;
  const web: ServiceFact = { name: "web", state: "ready", port: 5173, declared: true, wantsPreview: true };
  const api: ServiceFact = { name: "api", state: "ready", port: 8080, declared: true, wantsPreview: false };
  observeRunning(s, { services: [web, api], listening: [{ port: 3000 }, { port: 5173 }, { port: 8080 }] });
  s.registry.allocatePreviews(s.thread.pylonId, ["web"], { first: 10200, last: 10299 });
  assert.deepEqual(await ports(), [
    { port: 3000, service: null, preview: null },
    { port: 5173, service: "web", preview: { pylon: s.thread.pylonId, service: "web", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" } },
    { port: 8080, service: "api", preview: null },
  ]);
  observeRunning(s, { listening: null });
  assert.equal(await ports(), null, "ports the node could not read are unknown, not none");
  s.registry.ingested({ ...s.registry.node(node)!.observation!, pylons: [stoppedPylon(s.thread.pylonId, { sessions: null })] }, []);
  assert.deepEqual(await ports(), [], "nothing listens in a stopped pylon");
});

test("linking a port goes through the node's probe, gives it an https port at once, and counts as human activity", async (t) => {
  const s = await withThread(t);
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  const linked = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  const preview = { pylon: s.thread.pylonId, service: "port-3000", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" };
  assert.deepEqual(linked, { status: 200, body: preview });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "link-port", port: 3000 }]]);
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node), "the loop publishes the new port at its next pass");
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 }), { status: 200, body: preview }, "linking again answers the same preview");
  observeRunning(s, { services: [], listening: [{ port: 3000 }] });
  assert.deepEqual(((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports, [{ port: 3000, service: "port-3000", preview }], "the port has its preview before the node lists its service");
  observeRunning(s, { services: [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], listening: [{ port: 3000 }] });
  assert.deepEqual(((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports, [{ port: 3000, service: "port-3000", preview }]);

  // A port a declared service owns is previewed under that service.
  s.probeAnswers(async () => ({ kind: "link-port", service: "web" }));
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 5173 })).body.service, "web");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 70000 })).status, 400);
  const commands = s.commands.length;
  const reserved = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 22 });
  assert.equal(reserved.status, 400);
  assert.match(reserved.body.error, /is Nexus's own/);
  assert.equal(s.commands.length, commands, "a reserved port never reaches the probe");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000, title: "App" })).status, 400, "a preview has no title");
});

test("a preview that finds no free port answers 503, and any other allocation fault 500", async (t) => {
  const s = await withThread(t);
  const allocate = s.registry.allocatePreviews;
  s.registry.allocatePreviews = (pylon, services) => allocate(pylon, services, { first: 10200, last: 10199 });
  const full = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  assert.equal(full.status, 503);
  assert.match(full.body.error, /no https port is free for the preview of port-3000/);
  s.registry.allocatePreviews = () => { throw new Error("database is locked"); };
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 }), { status: 500, body: { error: "database is locked" } });
});

test("a node's probe that refuses the control plane answers 502", async (t) => {
  const s = await withThread(t);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat refused this caller"), { code: "forbidden" }); });
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 }), { status: 502, body: { error: "rj-firebat refused this caller" } });
});

test("linking a port of a pylon that is not running, or of an archived or deleted thread, is refused with 409", async (t) => {
  const s = await withThread(t);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  const paused = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: connect ECONNREFUSED"), { code: "unreachable" }); });
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).status, 503);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.commands.length = 0;
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).status, 409);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).status, 409);
  assert.deepEqual(s.commands, [], "an archived or deleted thread's probe is never asked");
  assert.deepEqual(s.registry.previews(s.thread.pylonId), []);
});

test("unpublishing a linked port goes through the node's probe, drops its preview at once, counts as human activity, and is safe to repeat", async (t) => {
  const s = await withThread(t);
  const detail = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail;
  const linked = (await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).body;
  // The node's last read still lists the port's service, as it does until its next read.
  observeRunning(s, { services: [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], listening: [{ port: 3000 }] });
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  s.commands.length = 0;
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {}), { status: 204, body: null });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "unlink-port", port: 3000 }]]);
  assert.deepEqual((await detail()).previews, []);
  assert.deepEqual((await detail()).ports, [{ port: 3000, service: "port-3000", preview: null }], "the port is listed again, without a preview");
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node), "the loop publishes the previews without it at its next pass");
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {}), { status: 204, body: null }, "unpublishing again succeeds");
  assert.equal(s.commands.length, 2, "and asks the pylon again, which knows whether the port is linked");
  assert.deepEqual((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).body, linked, "the port can be published again, on the port it freed");

  // The pylon refuses a port a service's preview owns, and its reason, which names the service, is the whole error.
  s.registry.allocatePreviews(s.thread.pylonId, ["web"], { first: 10200, last: 10299 });
  const reason = "Port 5173 is the preview of service web, not a linked port. Remove the preview from /home/user/workspace/repo/.nexus/services.yaml to unpublish it";
  s.probeAnswers(async () => ({ kind: "unlink-port", refused: reason }));
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/5173`, {}), { status: 422, body: { error: reason } });
  assert.deepEqual((await detail()).previews.map((p) => p.service), ["port-3000", "web"], "a refused unlink keeps every preview");

  s.commands.length = 0;
  for (const port of ["abc", "0", "70000", "22"]) assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/${port}`, {})).status, 400, port);
  assert.deepEqual(s.commands, [], "a bad or reserved port never reaches the probe");
});

test("unpublishing a port of a pylon that is not running, or of an archived or deleted thread, is refused with 409", async (t) => {
  const s = await withThread(t);
  await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.woken.length = 0;
  const paused = await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {});
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.woken.includes(node), "the request wakes the pylon");
  assert.deepEqual(s.registry.previews(s.thread.pylonId).map((p) => p.service), ["port-3000"], "the preview stays until the pylon unlinks the port");
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: connect ECONNREFUSED"), { code: "unreachable" }); });
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {})).status, 503);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.commands.length = 0;
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {})).status, 409);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {})).status, 409);
  assert.deepEqual(s.commands, [], "an archived or deleted thread's probe is never asked");
});

test("opening a session goes through the node's probe, defaults to Claude Code titled by its harness, and counts as human activity", async (t) => {
  const s = await withThread(t);
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, {}), { status: 201, body: { herdrPane: "w1:p1", harness: "claude-code", title: "claude-code" } });
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, { harness: "pi", title: " plan " }), { status: 201, body: { herdrPane: "w1:p1", harness: "pi", title: "plan" } });
  assert.deepEqual(s.commands, [
    [s.thread.pylonId, { kind: "open-session", harness: "claude-code", title: "claude-code" }],
    [s.thread.pylonId, { kind: "open-session", harness: "pi", title: "plan" }],
  ]);
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node));

  s.commands.length = 0;
  for (const body of [{ harness: "codex" }, { title: "" }, { title: "x".repeat(81) }, { resume: "bd2c2d6b" }]) {
    assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(s.commands, [], "a bad request never reaches the probe");
});

test("a thread's files and changes are read from its checkout through its node's probe, and reading counts as human activity", async (t) => {
  const s = await withThread(t);
  const { repo, base } = await localCheckout(t, s);
  await writeFile(join(repo, "src", "app.ts"), "export const a = 2;\n");
  await writeFile(join(repo, "shot.png"), Buffer.from([0x89, 0x50, 0, 255]));
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  const id = s.thread.id;

  const root = await s.call("GET", `/v1/threads/${id}/files`);
  assert.equal(root.status, 200);
  assert.deepEqual(root.body.entries.filter((e: { name: string }) => e.name !== ".git"), [{ name: "shot.png", kind: "file", size: 4 }, { name: "src", kind: "dir", size: null }]);
  assert.deepEqual((await s.call("GET", `/v1/threads/${id}/files?path=src`)).body, { path: "src", entries: [{ name: "app.ts", kind: "file", size: 20 }], truncated: false });

  const shot = await s.raw(`/v1/threads/${id}/files/content?path=shot.png`);
  assert.equal(shot.status, 200);
  assert.deepEqual(shot.body, Buffer.from([0x89, 0x50, 0, 255]));
  assert.equal(shot.headers["content-type"], "image/png");
  assert.equal(shot.headers["x-content-type-options"], "nosniff");
  assert.equal(shot.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal((await s.raw(`/v1/threads/${id}/files/content?path=src%2Fapp.ts`)).body.toString(), "export const a = 2;\n");

  assert.deepEqual(await s.call("GET", `/v1/threads/${id}/changes`), {
    status: 200,
    body: {
      base: { kind: "start", commit: base },
      files: [
        { path: "shot.png", oldPath: null, status: "added", additions: null, deletions: null },
        { path: "src/app.ts", oldPath: null, status: "modified", additions: 1, deletions: 1 },
      ],
      truncated: false,
    },
  });
  const diff = await s.call("GET", `/v1/threads/${id}/diff?base=head&path=src%2Fapp.ts`);
  assert.equal(diff.status, 200);
  assert.equal(diff.body.base.kind, "head");
  assert.match(diff.body.diff, /^diff --git a\/src\/app.ts b\/src\/app.ts\n[^]*-export const a = 1;\n\+export const a = 2;\n$/);

  assert.ok(s.streams.every(([pylon, argv]) => pylon === s.thread.pylonId && argv[0] === "python3"));
  assert.ok(s.registry.thread(id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node));
});
const gifBytes = Buffer.from("GIF89a pixels");

test("a thread's checkout images are served while its pylon runs, sniffed, and the file at a base too", async (t) => {
  const s = await withThread(t);
  const { repo, run } = await localCheckout(t, s);
  observeRunning(s, {});
  await writeFile(join(repo, "shot.png"), pngBytes);
  await run("add", "shot.png");
  await run("commit", "-q", "-m", "shot");
  await writeFile(join(repo, "shot.png"), gifBytes);
  const active = s.registry.thread(s.thread.id)!.lastHumanActivityAt;
  s.woken.length = 0;
  const image = (query: string) => s.raw(`/v1/threads/${s.thread.id}/image?${query}`);

  const now = await image("source=file&path=shot.png");
  assert.equal(now.status, 200);
  assert.deepEqual(now.body, gifBytes);
  assert.equal(now.headers["content-type"], "image/gif", "the bytes say what it is, not its name");
  assert.equal(now.headers["x-content-type-options"], "nosniff");
  assert.equal(now.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal(now.headers["cache-control"], "no-cache");
  const before = await image("source=file&path=shot.png&base=head");
  assert.deepEqual([before.status, before.headers["content-type"]], [200, "image/png"]);
  assert.deepEqual(before.body, pngBytes);
  assert.equal((await image("source=file&path=shot.png&base=start")).status, 404, "the file was added after the start");

  await writeFile(join(repo, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  await writeFile(join(repo, "fake.png"), "not a png");
  for (const path of ["logo.svg", "fake.png", "src/app.ts"]) assert.equal((await image(`source=file&path=${encodeURIComponent(path)}`)).status, 415, path);
  await writeFile(join(repo, "huge.png"), Buffer.concat([pngBytes, Buffer.alloc(10 << 20)]));
  assert.equal((await image("source=file&path=huge.png")).status, 413);
  assert.equal((await image("source=file&path=..%2Fsecret.png")).status, 400);
  for (const query of ["source=file", "source=disk&path=shot.png", "source=file&path=shot.png&base=yesterday", "source=harness&entry=1&message=0&part=0&sha256=x"]) {
    assert.equal((await image(query)).status, 400, query);
  }
  assert.equal(s.registry.thread(s.thread.id)!.lastHumanActivityAt, active, "an image's load is not the person's activity");
  assert.deepEqual(s.woken, []);
});

test("an image is refused with a 409 while the pylon does not run, without waking it, and a caller who may not read files may not read images", async (t) => {
  const s = await withThread(t);
  await localCheckout(t, s);
  const active = s.registry.thread(s.thread.id)!.lastHumanActivityAt;
  s.woken.length = 0;
  const route = `/v1/threads/${s.thread.id}/image?source=file&path=src%2Fapp.ts`;
  const paused = await s.call("GET", route);
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running, and this request does not wake it/);
  assert.deepEqual(s.streams, [], "the probe is never asked");
  assert.deepEqual(s.woken, []);
  assert.equal(s.registry.thread(s.thread.id)!.lastHumanActivityAt, active);

  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.call("GET", `/v1/threads/${s.thread.id}/files/content?path=src%2Fapp.ts`)).status, 403);
  assert.equal((await s.call("GET", route)).status, 403);
  s.callAs(laptop);
  assert.equal((await s.call("GET", "/v1/threads/th-nope/files/content?path=src%2Fapp.ts")).status, 404);
  assert.equal((await s.call("GET", "/v1/threads/th-nope/image?source=file&path=src%2Fapp.ts")).status, 404);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.woken.length = 0;
  assert.equal((await s.call("GET", route)).status, 409);
  assert.deepEqual(s.woken, []);
});

test("a harness conversation's image part is served by its hash, and a part that changed is gone", async (t) => {
  const s = await withThread(t);
  const data = pngBytes.toString("base64");
  const transcript = s.fake.transcript(s.thread.id);
  transcript.messages.push({ role: "toolResult", toolCallId: "c1", toolName: "screenshot", content: [{ type: "text", text: "taken" }, { type: "image", data, mimeType: "image/png" }], isError: false, timestamp: 0 });
  s.fake.commit(s.thread.id);
  const entry = transcript.messages.length;
  const sha256 = createHash("sha256").update(data).digest("hex");
  s.woken.length = 0;
  const shot = await s.raw(`/v1/threads/${s.thread.id}/image?source=harness&entry=${entry}&message=0&part=1&sha256=${sha256}`);
  assert.equal(shot.status, 200);
  assert.deepEqual(shot.body, pngBytes);
  assert.equal(shot.headers["content-type"], "image/png");
  assert.equal(shot.headers["cache-control"], "private, max-age=31536000, immutable");
  assert.equal(shot.headers["x-content-type-options"], "nosniff");
  assert.equal((await s.raw(`/v1/threads/${s.thread.id}/image?source=harness&entry=${entry}&message=0&part=1&sha256=${"0".repeat(64)}`)).status, 404);
  assert.equal((await s.raw(`/v1/threads/${s.thread.id}/image?source=harness&entry=${entry}&message=0&part=0&sha256=${sha256}`)).status, 404, "a text part is no image");

  const big = Buffer.concat([pngBytes, Buffer.alloc(10 << 20)]).toString("base64");
  transcript.messages.push({ role: "user", content: [{ type: "image", data: big, mimeType: "image/png" }], timestamp: 0 });
  s.fake.commit(s.thread.id);
  const bigSha = createHash("sha256").update(big).digest("hex");
  assert.equal((await s.raw(`/v1/threads/${s.thread.id}/image?source=harness&entry=${transcript.messages.length}&message=0&part=0&sha256=${bigSha}`)).status, 413);
  transcript.messages.push({ role: "user", content: [{ type: "image", data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" }], timestamp: 0 });
  s.fake.commit(s.thread.id);
  const svgSha = createHash("sha256").update(Buffer.from("<svg/>").toString("base64")).digest("hex");
  assert.equal((await s.raw(`/v1/threads/${s.thread.id}/image?source=harness&entry=${transcript.messages.length}&message=0&part=0&sha256=${svgSha}`)).status, 415);
  assert.deepEqual(s.woken, [], "a harness image needs no pylon");
});

test("a scratch thread's changes and diff are against the empty tree, before its first commit and after", async (t) => {
  const s = await withThread(t);
  const scratch = await tempDir("nexus-api-scratch-", t);
  const repo = join(scratch, "repo");
  await git("sh", ["-c", repoInitCommand({ kind: "empty", branch: "main" }, repo)]);
  const run = (...args: string[]) => git("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  s.probePipes(async (argv) => processStream(argv[0]!, argv.slice(1).map((arg) => arg === checkoutDir ? repo : arg), () => {}));
  const id = s.thread.id;
  const added = (path: string, additions: number) => ({ path, oldPath: null, status: "added", additions, deletions: 0 });
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "README.md"), "# sketch\n");
  await writeFile(join(repo, "src", "main.go"), "package main\n");

  for (const kind of ["start", "head"]) {
    assert.deepEqual(await s.call("GET", `/v1/threads/${id}/changes?base=${kind}`), {
      status: 200,
      body: { base: { kind, commit: null }, files: [added("README.md", 1), added("src/main.go", 1)], truncated: false },
    }, kind);
  }
  const diff = await s.call("GET", `/v1/threads/${id}/diff?path=README.md`);
  assert.equal(diff.status, 200);
  assert.deepEqual(diff.body.base, { kind: "start", commit: null });
  assert.match(diff.body.diff, /^diff --git a\/README.md b\/README.md\nnew file mode 100644\n[^]*--- \/dev\/null\n\+\+\+ b\/README.md\n@@ -0,0 \+1 @@\n\+# sketch\n$/);

  await run("add", "-A");
  await run("commit", "-q", "-m", "first");
  const head = (await run("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(repo, "README.md"), "# sketch\nmore\n");
  await writeFile(join(repo, "notes.txt"), "later\n");
  assert.deepEqual(await s.call("GET", `/v1/threads/${id}/changes`), {
    status: 200,
    body: { base: { kind: "start", commit: null }, files: [added("README.md", 2), added("notes.txt", 1), added("src/main.go", 1)], truncated: false },
  }, "the agent's commit is a change since the start too");
  assert.deepEqual(await s.call("GET", `/v1/threads/${id}/changes?base=head`), {
    status: 200,
    body: { base: { kind: "head", commit: head }, files: [{ path: "README.md", oldPath: null, status: "modified", additions: 1, deletions: 0 }, added("notes.txt", 1)], truncated: false },
  });
});

test("a checkout read the pylon refuses answers its status, and a bad request never reaches the probe", async (t) => {
  const s = await withThread(t);
  const { run } = await localCheckout(t, s);
  const id = s.thread.id;
  const refusal = async (path: string, status: number, message: RegExp) => {
    const reply = await s.call("GET", path);
    assert.equal(reply.status, status, path);
    assert.match(reply.body.error, message, path);
  };
  await refusal(`/v1/threads/${id}/files?path=nope`, 404, /nope does not exist/);
  await refusal(`/v1/threads/${id}/files/content?path=src`, 400, /src is not a file/);
  await refusal(`/v1/threads/${id}/files?path=..%2F..`, 400, /outside the checkout/);
  await run("update-ref", "-d", "refs/nexus/base");
  await refusal(`/v1/threads/${id}/changes`, 422, /no refs\/nexus\/base/);
  assert.equal((await s.call("GET", `/v1/threads/${id}/changes?base=head`)).status, 200);

  s.streams.length = 0;
  for (const path of [`/v1/threads/${id}/changes?base=main`, `/v1/threads/${id}/diff?base=tip`, `/v1/threads/${id}/files/content`, `/v1/threads/${id}/files/content?path=`, `/v1/threads/${id}/files?path=a%00b`, `/v1/threads/${id}/diff?${Array(100).fill(`path=${"p".repeat(154)}`).join("&")}`, `/v1/threads/${id}/files?path=${"%C3%A9".repeat(2000)}`]) {
    assert.equal((await s.call("GET", path)).status, 400, path);
  }
  assert.deepEqual(s.streams, [], "a bad request never reaches the probe");
});

test("reading the checkout of a pylon that is not running wakes it and is refused with 409, and an archived thread's probe is never asked", async (t) => {
  const s = await withThread(t);
  s.probePipes(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.woken.length = 0;
  const paused = await s.call("GET", `/v1/threads/${s.thread.id}/changes`);
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.woken.includes(node));
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.streams.length = 0;
  assert.equal((await s.call("GET", `/v1/threads/${s.thread.id}/files`)).status, 409);
  assert.deepEqual(s.streams, []);
});

test("a checkout read whose thread is deleted while it runs answers the delete, not the node's failure", async (t) => {
  const s = await withThread(t);
  s.probePipes(async () => {
    assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
    throw new Error(`rj-firebat: ${s.thread.pylonId} is not running`);
  });
  const read = await s.call("GET", `/v1/threads/${s.thread.id}/changes`);
  assert.equal(read.status, 409);
  assert.match(read.body.error, /is deleted/);
});

test("closing a session goes through the node's probe, and a pane that is not open, such as one from before a wake, is a 404", async (t) => {
  const s = await withThread(t);
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {}), { status: 204, body: null });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "close-session", herdrPane: "w1:p1" }]]);
  s.probeAnswers(async () => ({ kind: "close-session", outcome: "not-open" }));
  const stale = await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {});
  assert.equal(stale.status, 404);
  assert.match(stale.body.error, /no session is open in pane w1:p1 .* A wake may have moved it/);
});

test("focusing a session runs Herdr's focus on its pane in the pylon as an argument, a pane that is not open is a 404, and anything but a pane ID is a 400", async (t) => {
  const s = await withThread(t);
  const focus = (pane: string) => s.call("POST", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent(pane)}/focus`, {});
  assert.deepEqual(await focus("w3:p1"), { status: 204, body: null });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "exec", argv: ["sh", "-c", focusScript, "focus", "w3:p1"], cwd: "/", timeoutMs: 15_000 }]]);
  s.probeAnswers(async () => ({ kind: "exec", exitCode: 1, output: "", truncated: false }));
  assert.deepEqual(await focus("w9:p1"), { status: 404, body: { error: `no pane w9:p1 is open in pylon ${s.thread.pylonId}` } });
  for (const pane of ["p1", "w1:p1;reboot", "$(id)", "w1:p1 w2:p1"]) {
    const refused = await focus(pane);
    assert.equal(refused.status, 400, pane);
    assert.match(refused.body.error, /^pane must be a Herdr pane ID such as w1:p1/);
  }
  assert.equal(s.commands.length, 2, "no refused pane reached the probe");
});

test("closing a listed session names it, and a pane that runs another session now is a 404 that leaves it open", async (t) => {
  const s = await withThread(t);
  s.registry.apply({ record: "sessions", pylonId: s.thread.pylonId, sessions: [
    { id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", title: "review", status: "idle", message: null },
  ] });
  s.probeAnswers(async () => ({ kind: "close-session", outcome: "moved" }));
  const moved = await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {});
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "close-session", herdrPane: "w1:p1", session: { harness: "claude-code", harnessSessionId: "s1", title: "review" } }]]);
  assert.equal(moved.status, 404);
  assert.match(moved.body.error, /pane w1:p1 of pylon \S+ runs another session now, so it was left open. A wake moved session w1:p1 to another pane/);
});

/** Records the thread's pylon stopped with these sessions, as the loop would from the node's observation. */
function observeStopped(s: Awaited<ReturnType<typeof withThread>>, sessions: readonly PausedSession[]) {
  s.registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  const stopped = stoppedPylon(s.thread.pylonId, { sessions });
  s.registry.ingested(testObservation(node, { pylons: [stopped] }),
    ingest({ type: "pylon", pylon: stopped }, node, new Map([[s.thread.pylonId, "absent"]]), Date.now()));
}

const pausedReview: PausedSession = { id: "w1:p1", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", title: "review" };

test("an idle-paused or archived thread lists the sessions its wake brings back, as paused", async (t) => {
  const s = await withThread(t);
  s.registry.apply({ record: "sessions", pylonId: s.thread.pylonId, sessions: [{ ...pausedReview, herdrPane: "w1:p1", state: "running", status: "working", message: null }] });
  observeStopped(s, [pausedReview]);
  const sessions = async () => ((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).sessions;
  const paused = [{ pylon: s.thread.pylonId, ...pausedReview, state: "paused", status: "working", message: null }];
  assert.deepEqual(await sessions(), paused);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  assert.deepEqual(await sessions(), paused);
});

test("closing a paused session is refused with 409 without asking the probe or waking the pylon", async (t) => {
  const s = await withThread(t);
  observeStopped(s, [pausedReview]);
  // Timestamps only move forward, so this is the thread's start.
  const human = s.registry.thread(s.thread.id)!.lastHumanActivityAt;
  s.woken.length = 0;
  const idle = await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {});
  assert.equal(idle.status, 409);
  assert.match(idle.body.error, /session w1:p1 is paused with its pylon and resumes when its pylon wakes. Close it once it runs/);
  assert.deepEqual(s.woken, []);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.woken.length = 0;
  const archived = await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {});
  assert.equal(archived.status, 409);
  assert.match(archived.body.error, /resumes when `nexus unarchive .*` wakes its pylon/);
  assert.deepEqual(s.commands, []);
  assert.deepEqual(s.woken, []);
  assert.equal(s.registry.thread(s.thread.id)!.lastHumanActivityAt, human, "a refused close is not activity");
});

test("closing a failed session in no pane drops it from the pylon, by its ID", async (t) => {
  const s = await withThread(t);
  const id = "failed-0123456789ab";
  s.registry.apply({ record: "sessions", pylonId: s.thread.pylonId, sessions: [
    { id, state: "failed", herdrPane: null, harness: "pi", harnessSessionId: null, title: "plan", status: null, message: "pi exited 1" },
  ] });
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${id}`, {}), { status: 204, body: null });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "drop-failed-session", id }]]);
  s.probeAnswers(async () => ({ kind: "drop-failed-session", dropped: false }));
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${id}`, {})).status, 404);
});

test("a session of a pylon that is not running, or of an archived or deleted thread, is refused with 409", async (t) => {
  const s = await withThread(t);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.woken.length = 0;
  const paused = await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, { harness: "claude-code" });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.woken.includes(node), "the request wakes the pylon");
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/w1:p1`, {})).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.commands.length = 0;
  const archived = await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, {});
  assert.equal(archived.status, 409);
  assert.match(archived.body.error, /is archived, so its pylon stays paused/);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/w1:p1`, {})).status, 409);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, {})).status, 409);
  assert.deepEqual(s.commands, [], "an archived or deleted thread's probe is never asked");
});
