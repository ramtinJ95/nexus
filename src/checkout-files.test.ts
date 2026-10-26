import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { checkoutReader, CheckoutRefused, contentType, maxFileBytes, maxOpenPipes, pathsFit, type OpenPipe } from "./checkout-files.ts";
import { processStream } from "./process-stream.ts";
import { claudeTurn, snapshotTurn } from "../images/pylon/nexus-turn.ts";
import type { ByteStream, StreamEnd } from "./protocol.ts";

const run = promisify(execFile);

/** Each pipe runs the helper on this machine, as a pylon would over its raw pipe. */
function localPipes(): { open: OpenPipe; requests: (readonly string[])[]; stderr: string[] } {
  const requests: (readonly string[])[] = [];
  const stderr: string[] = [];
  return {
    requests, stderr,
    open: async (argv) => {
      requests.push(argv);
      return processStream(argv[0]!, argv.slice(1), (text) => { stderr.push(text); });
    },
  };
}

/** A checkout whose first commit is refs/nexus/base, as a pylon's first boot records it. */
async function checkout(t: TestContext) {
  const scratch = await mkdtemp(join(tmpdir(), "nexus-checkout-"));
  t.after(() => rm(scratch, { recursive: true }));
  const dir = join(scratch, "repo");
  await mkdir(join(dir, "src"), { recursive: true });
  const git = async (...args: string[]) => (await run("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args])).stdout;
  await writeFile(join(dir, "app.txt"), "one\ntwo\n");
  await writeFile(join(dir, "src", "old.ts"), "export const a = 1;\n".repeat(20));
  await writeFile(join(dir, ".gitignore"), "dist/\n");
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-q", "-m", "first");
  await git("update-ref", "refs/nexus/base", "HEAD");
  const pipes = localPipes();
  return { scratch, dir, git, ...pipes, reader: checkoutReader(pipes.open, dir), base: (await git("rev-parse", "HEAD")).trim() };
}

const refused = (kind: string, message: RegExp) => (err: unknown) => err instanceof CheckoutRefused && err.kind === kind && message.test(err.message);

test("a listing gives each entry's kind and a file's size, sorted by name, and the checkout is the empty path", async (t) => {
  const c = await checkout(t);
  await symlink("app.txt", join(c.dir, "link"));
  const root = await c.reader.list("");
  assert.equal(root.path, "");
  assert.equal(root.truncated, false);
  assert.deepEqual(root.entries.filter((e) => e.name !== ".git"), [
    { name: ".gitignore", kind: "file", size: 6 },
    { name: "app.txt", kind: "file", size: 8 },
    { name: "link", kind: "symlink", size: null },
    { name: "src", kind: "dir", size: null },
  ]);
  assert.deepEqual(await c.reader.list("src/"), { path: "src", entries: [{ name: "old.ts", kind: "file", size: 400 }], truncated: false });
  // The helper goes in on stdin, so the request, which the probe takes in its URL, stays short.
  assert.deepEqual(c.requests[0], ["python3", "-", c.dir, "list", ""]);
});

test("a path that leaves the checkout is refused, through .. or through a symlink", async (t) => {
  const c = await checkout(t);
  await writeFile(join(c.scratch, "secret"), "token");
  await symlink(join(c.scratch, "secret"), join(c.dir, "escape"));
  await assert.rejects(c.reader.list(".."), refused("outside", /\.\. is outside the checkout/));
  await assert.rejects(c.reader.read("../secret"), refused("outside", /outside the checkout/));
  await assert.rejects(c.reader.read("escape"), refused("outside", /escape is outside the checkout/));
  await assert.rejects(c.reader.diff("head", ["../secret"]), refused("outside", /outside the checkout/));
});

test("reading gives a file's bytes, and refuses a missing path, a directory, or a file over the limit", async (t) => {
  const c = await checkout(t);
  const pixels = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  await writeFile(join(c.dir, "shot.png"), pixels);
  assert.deepEqual(await c.reader.read("shot.png"), pixels);
  assert.equal((await c.reader.read("app.txt")).toString(), "one\ntwo\n");
  await assert.rejects(c.reader.read("nope.txt"), refused("missing", /nope.txt does not exist/));
  await assert.rejects(c.reader.list("nope"), refused("missing", /nope does not exist/));
  await assert.rejects(c.reader.read("src"), refused("kind", /src is not a file/));
  await assert.rejects(c.reader.list("app.txt"), refused("kind", /app.txt is not a directory/));
  await writeFile(join(c.dir, "big.bin"), Buffer.alloc(maxFileBytes + 1));
  await assert.rejects(c.reader.read("big.bin"), refused("large", /big.bin is over the 10485760-byte limit/));
});

test("changes since the start include commits, staged, unstaged and untracked work, leave ignored files out, and leave the index alone", async (t) => {
  const c = await checkout(t);
  await writeFile(join(c.dir, "app.txt"), "one\n2\nthree\n");
  await c.git("commit", "-q", "-am", "agent work");
  await c.git("mv", "src/old.ts", "src/new.ts");
  await writeFile(join(c.dir, "notes.md"), "untracked\n");
  await writeFile(join(c.dir, "pixel.bin"), Buffer.from([0, 1, 2]));
  await mkdir(join(c.dir, "dist"));
  await writeFile(join(c.dir, "dist", "bundle.js"), "ignored\n");
  const indexBefore = await readFile(join(c.dir, ".git", "index"));

  const since = await c.reader.changes("start");
  assert.deepEqual(since, {
    base: { kind: "start", commit: c.base },
    files: [
      { path: "app.txt", oldPath: null, status: "modified", additions: 2, deletions: 1 },
      { path: "notes.md", oldPath: null, status: "added", additions: 1, deletions: 0 },
      { path: "pixel.bin", oldPath: null, status: "added", additions: null, deletions: null },
      { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0 },
    ],
    truncated: false,
  });
  // Since HEAD leaves the committed edit out.
  const head = await c.reader.changes("head");
  assert.equal(head.base.commit, (await c.git("rev-parse", "HEAD")).trim());
  assert.deepEqual(head.files.map((f) => f.path), ["notes.md", "pixel.bin", "src/new.ts"]);
  assert.deepEqual(await readFile(join(c.dir, ".git", "index")), indexBefore);
  assert.equal((await c.git("status", "--porcelain")).includes("?? notes.md"), true);
});

test("a diff is the unified diff from the base, of the whole tree or of the paths asked for", async (t) => {
  const c = await checkout(t);
  await writeFile(join(c.dir, "app.txt"), "one\n2\n");
  await writeFile(join(c.dir, "notes.md"), "untracked\n");
  // The agent's git config must not change the diff.
  await c.git("config", "diff.noprefix", "true");
  await c.git("config", "color.diff", "always");

  const whole = await c.reader.diff("start", []);
  assert.equal(whole.truncated, false);
  assert.deepEqual(whole.base, { kind: "start", commit: c.base });
  assert.match(whole.diff, /^diff --git a\/app.txt b\/app.txt\n/);
  assert.match(whole.diff, /\n-two\n\+2\n/);
  assert.match(whole.diff, /diff --git a\/notes.md b\/notes.md\nnew file mode/);
  assert.doesNotMatch(whole.diff, /\x1b\[/);

  const one = await c.reader.diff("start", ["notes.md"]);
  assert.match(one.diff, /^diff --git a\/notes.md b\/notes.md\n/);
  assert.doesNotMatch(one.diff, /app.txt/);
  // A path is literal, never a glob.
  assert.equal((await c.reader.diff("start", ["*.md"])).diff, "");
});

test("a file rewritten at the same size right after a commit shows as changed, even when the diff is the first read", async (t) => {
  const c = await checkout(t);
  // Same size, likely the same second as the commit's index: only git's check against the index's own mtime catches it.
  await writeFile(join(c.dir, "app.txt"), "one\nTWO\n");
  assert.match((await c.reader.diff("head", ["app.txt"])).diff, /\n-two\n\+TWO\n/);
  assert.deepEqual((await c.reader.changes("head")).files.map((f) => f.path), ["app.txt"]);
});

test("a diff over 4 MiB stops at its last whole line before the limit and says it was cut", async (t) => {
  const c = await checkout(t);
  await writeFile(join(c.dir, "huge.txt"), "a line of generated output\n".repeat(300_000));
  const { diff, truncated } = await c.reader.diff("head", []);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(diff) <= 4 << 20);
  assert.match(diff, /^diff --git a\/huge.txt b\/huge.txt\n/);
  assert.match(diff, /\n\+a line of generated output\n$/);
});

test("a pylon that booted before the base was recorded is refused for changes since the start, and HEAD still works", async (t) => {
  const c = await checkout(t);
  await c.git("update-ref", "-d", "refs/nexus/base");
  await assert.rejects(c.reader.changes("start"), refused("no-base", /no refs\/nexus\/base/));
  await assert.rejects(c.reader.diff("start", []), refused("no-base", /changes since HEAD instead/));
  assert.deepEqual((await c.reader.changes("head")).files, []);
});

test("a missing checkout is refused, and a helper that fails says where its stderr went", async (t) => {
  const c = await checkout(t);
  const gone = checkoutReader(c.open, join(c.scratch, "nowhere"));
  await assert.rejects(gone.list(""), refused("missing", /the pylon has no checkout at/));
  await writeFile(join(c.dir, ".git", "index"), "not an index");
  await assert.rejects(c.reader.changes("head"), /the checkout reader exited 1. Its stderr is in the node's probe log/);
  assert.match(c.stderr.join(""), /git add --all exited/);
  await rm(join(c.dir, ".git"), { recursive: true });
  await assert.rejects(c.reader.changes("head"), refused("missing", /not a git repository/));
});

/** A pipe whose guest prints `reply` with sh, after reading the helper from stdin. */
const printing = (reply: string): OpenPipe => async () => processStream("sh", ["-c", `cat > /dev/null; ${reply}`], () => {});

test("a reply the pylon cuts off, one that is not the helper's, or one too long to check fails with a short message", async () => {
  await assert.rejects(checkoutReader(printing(`printf '{"path"'; kill -9 $$`), "/repo").list(""), /pipe to the pylon was lost/);
  await assert.rejects(checkoutReader(printing("printf 'nope'"), "/repo").list(""), /reply is not JSON/);
  const forged = `printf '{"path": "", "entries": [{"name": "x", "kind": "device", "size": null}], "truncated": false}'`;
  await assert.rejects(checkoutReader(printing(forged), "/repo").list(""), /reply is malformed at entries.0.kind/);
  const flood = JSON.stringify({ path: "", entries: Array(20_000).fill(null), truncated: false });
  await assert.rejects(checkoutReader(printing(`printf '%s' '${flood}'`), "/repo").list(""), (err: Error) => /malformed at entries/.test(err.message) && err.message.length < 400);
});

test("a read the pylon does not finish within its deadline is refused as slow", async () => {
  const started = Date.now();
  await assert.rejects(checkoutReader(printing("sleep 2"), "/repo", 100).changes("head"), refused("slow", /did not finish reading its checkout within 0.1 s/));
  assert.ok(Date.now() - started < 1500);
});

test("a read abandoned at its deadline keeps nothing it reads after, and its pipe counts as open until it ends", async () => {
  // Prints far more than any reply after the deadline, then exits.
  const late = printing("sleep 0.3; head -c 20000000 /dev/zero");
  // Pipes other tests abandoned may still be open, and count too, so some of these may be refused as busy at once.
  const opened = Array.from({ length: maxOpenPipes }, () => checkoutReader(late, "/repo", 50).changes("head").catch((err: Error) => err));
  const kinds = (await Promise.all(opened)).map((err) => err instanceof CheckoutRefused ? err.kind : String(err));
  assert.ok(kinds.includes("slow") && kinds.every((kind) => kind === "slow" || kind === "busy"), kinds.join(", "));
  await assert.rejects(checkoutReader(printing("printf '{}'"), "/repo").changes("head"), refused("busy", /checkout reads are still open/));
  // Each pipe drains and closes in the background.
  for (let tries = 0; tries < 100; tries++) {
    const done = await checkoutReader(printing(`printf '{"path": "", "entries": [], "truncated": false}'`), "/repo").list("").then(() => true, (err: Error) => {
      if (!(err instanceof CheckoutRefused && err.kind === "busy")) throw err;
      return false;
    });
    if (done) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("the abandoned pipes never closed");
});

test("a read abandoned at its deadline lets go of what it already holds, though its guest stays silent", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  // Several chunks, then silence until the test ends the stream. Only the first is watched, because an iterator may
  // still hold its latest.
  let first: WeakRef<Uint8Array> | undefined;
  let finish!: (end: StreamEnd) => void;
  const done = new Promise<StreamEnd>((resolve) => { finish = resolve; });
  const stalled: ByteStream = {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 4; i++) {
        const chunk = new Uint8Array(1 << 20);
        if (i === 0) first = new WeakRef(chunk);
        yield chunk;
      }
      await done;
    },
    write: async () => {},
    close: async () => {},
    abort: () => {},
    done,
  };
  await assert.rejects(checkoutReader(async () => stalled, "/repo", 50).changes("head"), refused("slow", /within 0.05 s/));
  await new Promise((r) => setImmediate(r));
  gc();
  assert.equal(first!.deref(), undefined, "the chunks are released while the stream is still open");
  finish({ kind: "exited", code: 0 });
});

test("arguments too long for the probe's request are refused before any pipe opens", async () => {
  let opened = 0;
  const reader = checkoutReader(async () => { opened++; throw new Error("unreachable"); }, "/repo");
  assert.equal(pathsFit(["a".repeat(8000)]), true);
  assert.equal(pathsFit(Array(100).fill("p".repeat(154))), false);
  assert.equal(pathsFit(["é".repeat(2000)]), false, "each byte of a non-ASCII character is encoded on its own");
  await assert.rejects(reader.diff("head", Array(100).fill("p".repeat(154))), refused("long", /too long together/));
  await assert.rejects(reader.read("é".repeat(2000)), refused("long", /too long together/));
  // Paths that just fit are not refused by what else the read sends.
  const fitting = Array(100).fill("p".repeat(72));
  assert.equal(pathsFit(fitting), true);
  await assert.rejects(reader.diff("start", fitting), /unreachable/);
  assert.equal(opened, 1);
});

test("only raster images keep their type, so a repository's HTML or SVG is never served as a page", () => {
  assert.equal(contentType("shot.PNG", Buffer.from([0x89, 0])), "image/png");
  assert.equal(contentType("a/b.jpeg", Buffer.alloc(0)), "image/jpeg");
  assert.equal(contentType("index.html", Buffer.from("<script>alert(1)</script>")), "text/plain; charset=utf-8");
  assert.equal(contentType("logo.svg", Buffer.from("<svg onload=alert(1)>")), "text/plain; charset=utf-8");
  assert.equal(contentType("app.ts", Buffer.from("héllo")), "text/plain; charset=utf-8");
  assert.equal(contentType("blob", Buffer.from([0x61, 0, 0x62])), "application/octet-stream");
  assert.equal(contentType("latin1.txt", Buffer.from([0x68, 0xe9])), "application/octet-stream");
});

test("a turn snapshot captures staged, unstaged and untracked files without changing HEAD or the index", async (t) => {
  const c = await checkout(t);
  await writeFile(join(c.dir, "app.txt"), "staged\n");
  await c.git("add", "app.txt");
  await writeFile(join(c.dir, "app.txt"), "unstaged\n");
  await writeFile(join(c.dir, "new.txt"), "untracked\n");
  const index = await readFile(join(c.dir, ".git/index"));
  await c.reader.snapshot("turn-1");
  const commit = (await c.git("rev-parse", "refs/nexus/turn")).trim();
  assert.equal(await c.git("show", `${commit}:app.txt`), "unstaged\n");
  assert.equal(await c.git("show", `${commit}:new.txt`), "untracked\n");
  assert.deepEqual(await readFile(join(c.dir, ".git/index")), index);
  assert.equal((await c.git("rev-parse", "HEAD")).trim(), c.base);
  assert.deepEqual((await c.reader.changes("turn")).files, []);
  await writeFile(join(c.dir, "app.txt"), "reply\n");
  await c.git("commit", "-qam", "reply");
  await writeFile(join(c.dir, "later.txt"), "later\n");
  await c.reader.snapshot("turn-1");
  const changes = await c.reader.changes("turn");
  assert.deepEqual(changes.base, { kind: "turn", commit });
  assert.deepEqual(changes.files.map((f) => f.path), ["app.txt", "later.txt"]);
  const diff = await c.reader.diff("turn", ["app.txt"]);
  assert.deepEqual(diff.base, changes.base);
  assert.match(diff.diff, /-unstaged\n\+reply/);
  await c.reader.snapshot("turn-2");
  assert.deepEqual((await c.reader.changes("turn")).files, []);
});

test("latest turn refuses an older pylon and a failed snapshot invalidates its previous base", async (t) => {
  const c = await checkout(t);
  await assert.rejects(c.reader.changes("turn"), refused("no-base", /no latest-turn snapshot/));
  await assert.rejects(c.reader.diff("turn", []), refused("no-base", /no latest-turn snapshot/));
  await c.reader.snapshot("one");
  await writeFile(join(c.dir, ".git/index"), "broken index");
  await assert.rejects(c.reader.snapshot("two"));
  await assert.rejects(c.reader.changes("turn"), refused("no-base", /snapshot failed/));
  await c.reader.snapshot("two");
  await assert.rejects(c.reader.diff("turn", []), refused("no-base", /snapshot failed/));
});

test("the Claude hook's snapshot is the base of its turn, and one past its deadline leaves none under its ID", async (t) => {
  const c = await checkout(t);
  const helper = fileURLToPath(new URL("./checkout-files.py", import.meta.url));
  await writeFile(join(c.dir, "app.txt"), "before the turn\n");
  const first = claudeTurn("s1", 1000);
  assert.equal(await snapshotTurn(c.dir, first, 30_000, helper), true);
  await writeFile(join(c.dir, "turn.txt"), "the turn's\n");
  const changes = await checkoutReader(c.open, c.dir, undefined, first).changes("turn");
  assert.deepEqual(changes.files.map((f) => f.path), ["turn.txt"]);
  const second = claudeTurn("s1", 2000);
  assert.equal(await snapshotTurn(c.dir, second, 0, helper), false);
  await assert.rejects(checkoutReader(c.open, c.dir, undefined, second).changes("turn"), refused("no-base", /no latest-turn snapshot/));
});

test("a turn snapshot works before a scratch repository's first commit", async (t) => {
  const c = await checkout(t);
  await rm(join(c.dir, ".git"), { recursive: true });
  await c.git("init", "-q");
  await c.reader.snapshot("empty");
  await assert.rejects(c.git("rev-parse", "HEAD"));
  await assert.rejects(readFile(join(c.dir, ".git/index")), { code: "ENOENT" });
  assert.deepEqual((await c.reader.changes("turn")).files, []);
  await writeFile(join(c.dir, "fresh.txt"), "fresh\n");
  assert.deepEqual((await c.reader.changes("turn")).files.map((f) => f.path), ["fresh.txt"]);
});


test("a wholly empty scratch checkout has a non-null turn base and no changes", async (t) => {
  const c = await checkout(t);
  await rm(c.dir, { recursive: true });
  await mkdir(c.dir);
  await c.git("init", "-q");
  await c.reader.snapshot("first");
  const changes = await c.reader.changes("turn");
  assert.equal(changes.base.kind, "turn");
  assert.match(changes.base.commit!, /^[a-f0-9]{40}$/);
  assert.deepEqual(changes.files, []);
  assert.equal((await c.reader.diff("turn", [])).diff, "");
  await assert.rejects(c.git("rev-parse", "HEAD"));
  await assert.rejects(readFile(join(c.dir, ".git/index")), { code: "ENOENT" });
});
