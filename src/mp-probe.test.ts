import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempDir } from "./test-support/kit.ts";

const repo = new URL("..", import.meta.url).pathname;

/**
 * A checkout holding scripts/mp-probe.ts and a stand-in verify-nexus, which logs each call with the run name it was given.
 * Its `up` acts as FAKE_UP says: `lose` finds another probe's claim already made, `fail` claims and then fails,
 * `hang` claims and waits, and `ready` claims and leaves FAKE_STATE and FAKE_REGISTRY as the run's state and registry.
 */
async function probeCheckout(t: { after(fn: () => Promise<void>): void }) {
  const dir = await tempDir("mp-probe-", t);
  const root = join(dir, "repo");
  const base = join(root, ".verify", "nexus");
  const scripts = join(root, ".claude", "skills", "verify-nexus", "scripts");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(scripts, { recursive: true });
  await copyFile(join(repo, "scripts", "mp-probe.ts"), join(root, "scripts", "mp-probe.ts"));
  const calls = join(dir, "calls");
  await writeFile(join(scripts, "verify-nexus"), `#!/bin/sh
echo "$1 \${NEXUS_VERIFY_RUN:-}" >> ${calls}
mkdir -p ${base}
case "$1 $FAKE_UP" in
  "up lose") echo winner > ${base}/current; exit 1 ;;
  "up fail") echo "$NEXUS_VERIFY_RUN" > ${base}/current; exit 1 ;;
  "up hang") echo "$NEXUS_VERIFY_RUN" > ${base}/current; touch ${dir}/claimed; exec sleep 60 ;;
  "up ready") echo "$NEXUS_VERIFY_RUN" > ${base}/current; mkdir -p ${base}/runs/$NEXUS_VERIFY_RUN
    cp "$FAKE_STATE" ${base}/runs/$NEXUS_VERIFY_RUN/state.json; cp "$FAKE_REGISTRY" ${base}/runs/$NEXUS_VERIFY_RUN/registry.db ;;
  down*) rm -f ${base}/current ;;
esac
`, { mode: 0o755 });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const start = (up: "lose" | "fail" | "hang" | "ready", probe = "api", env: NodeJS.ProcessEnv = {}) => {
    const child = spawn(process.execPath, [join(root, "scripts", "mp-probe.ts"), probe], { env: { ...process.env, ...env, FAKE_UP: up }, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    return { child, exit: new Promise<number | null>((done) => child.once("exit", (code) => done(code))), out: () => out };
  };
  return {
    dir,
    start,
    claimed: () => existsSync(join(dir, "claimed")),
    current: async () => (await readFile(join(base, "current"), "utf8").catch(() => null))?.trim() ?? null,
    calls: async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean),
  };
}

test("a probe that loses the claim to another fails and leaves the other's stack up", async (t) => {
  const p = await probeCheckout(t);
  assert.equal(await p.start("lose").exit, 1);
  const calls = await p.calls();
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^up probe-\d+-\d+$/, "up was named the probe's own run");
  assert.equal(await p.current(), "winner", "the winner's claim stands, and no down ran");
});

test("a probe whose own up fails takes its run down", async (t) => {
  const p = await probeCheckout(t);
  assert.equal(await p.start("fail").exit, 1);
  assert.deepEqual((await p.calls()).map((c) => c.split(" ")[0]), ["up", "down"]);
  assert.equal(await p.current(), null);
});

test("a probe stopped during its up stops the up and takes its own run down", async (t) => {
  const p = await probeCheckout(t);
  const { child, exit } = p.start("hang");
  while (!p.claimed()) await new Promise((done) => setTimeout(done, 20));
  child.kill("SIGTERM");
  assert.equal(await exit, 143);
  assert.deepEqual((await p.calls()).map((c) => c.split(" ")[0]), ["up", "down"]);
  assert.equal(await p.current(), null);
});

/**
 * Runs `boot` against a stand-in API, which refuses with 415 a request that changes state without JSON as the real one
 * does, and a stand-in docker whose log of the timed pylon shows `resumeLine` from its third read on.
 */
async function bootAgainstFakes(t: { after(fn: () => Promise<void>): void }, resumeLine: string) {
  const p = await probeCheckout(t);
  const registry = join(p.dir, "registry.db");
  const db = new DatabaseSync(registry);
  db.exec("CREATE TABLE templates (id TEXT, record TEXT); CREATE TABLE nodes (name TEXT, observation TEXT)");
  db.prepare("INSERT INTO templates VALUES (?, ?)").run("tpl-1", JSON.stringify({ state: "ready" }));
  db.prepare("INSERT INTO nodes VALUES (?, ?)").run("n1", JSON.stringify({ artifacts: ["tpl-1"] }));
  db.close();
  const bin = join(p.dir, "bin");
  const reads = join(p.dir, "docker-reads");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), `#!/bin/sh
echo "$*" >> ${reads}
[ "$(wc -l < ${reads})" -ge 3 ] && echo "${resumeLine}"
exit 0
`, { mode: 0o755 });
  const deletes: string[] = [];
  let posted = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const answer = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.method !== "GET" && req.headers["content-type"] !== "application/json") return answer(415, { error: "requests that change state must have content-type application/json" });
      if (req.method === "POST" && req.url === "/v1/projects") return answer(201, {});
      if (req.method === "POST" && req.url === "/v1/threads") {
        posted++;
        return answer(201, posted === 1 ? { id: "th-warm", setup: { how: "fresh", reason: "no template", building: "tpl-1" } } : { id: "th-timed", setup: { how: "template", template: "tpl-1" } });
      }
      if (req.method === "DELETE") { deletes.push(req.url!); return answer(200, {}); }
      if (req.url === "/v1/threads/th-warm") return answer(200, { thread: { id: "th-warm" }, pylon: { id: "pylon-th-warm", actualState: "absent", failed: null } });
      if (req.url === "/v1/threads/th-timed") {
        return answer(200, { thread: { id: "th-timed", setup: { how: "template", template: "tpl-1" } }, pylon: { id: "pylon-th-timed", actualState: "running", failed: null } });
      }
      answer(404, {});
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const state = join(p.dir, "state.json");
  await writeFile(state, JSON.stringify({ api, bobApi: api, node: "n1", project: "spoon", templateRepo: "/tmp/template.git" }));
  const run = p.start("ready", "boot", { FAKE_STATE: state, FAKE_REGISTRY: registry, PATH: `${bin}:${process.env.PATH}` });
  const code = await run.exit;
  return {
    code,
    line: JSON.parse(run.out()) as { failed: number; error?: string; template?: string; bootMs?: number },
    deletes,
    dockerReads: (await readFile(reads, "utf8")).split("\n").filter(Boolean),
    current: await p.current(),
  };
}

test("boot stops its clock once the template's pylon runs and its resume exited, and its deletes carry JSON", async (t) => {
  const r = await bootAgainstFakes(t, "resume: exited 0");
  assert.equal(r.line.error, undefined);
  assert.equal(r.code, 0);
  assert.equal(r.line.template, "tpl-1");
  assert.equal(typeof r.line.bootMs, "number");
  assert.deepEqual(r.dockerReads, ["logs pylon-th-timed", "logs pylon-th-timed", "logs pylon-th-timed"], "the clock ran until the log showed the resume's exit");
  assert.deepEqual(r.deletes, ["/v1/threads/th-warm", "/v1/threads/th-timed"], "the API took both deletes, which it refuses without JSON");
  assert.equal(r.current, null, "the probe took its run down");
});

test("a boot whose resume exited non-zero is a failed run", async (t) => {
  const r = await bootAgainstFakes(t, "resume: exited 3");
  assert.equal(r.code, 1);
  assert.equal(r.line.failed, 1);
  assert.match(r.line.error!, /th-timed's resume exited 3/);
  assert.deepEqual(r.deletes, ["/v1/threads/th-warm", "/v1/threads/th-timed"]);
});

/** The real verify-nexus in a checkout whose Docker answers with nothing and whose stack.ts only waits. */
async function verifyCheckout(t: { after(fn: () => Promise<void>): void }) {
  const dir = await tempDir("mp-verify-", t);
  const root = join(dir, "repo");
  const scripts = join(root, ".claude", "skills", "verify-nexus", "scripts");
  const bin = join(dir, "bin");
  await mkdir(scripts, { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await mkdir(bin);
  await copyFile(join(repo, ".claude", "skills", "verify-nexus", "scripts", "verify-nexus"), join(scripts, "verify-nexus"));
  await writeFile(join(scripts, "stack.ts"), "setTimeout(() => {}, 60_000);\n");
  await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const base = join(root, ".verify", "nexus");
  const env = (run: string) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, NEXUS_VERIFY_RUN: run });
  return {
    base,
    verify: (args: string[], run: string) => spawn(join(scripts, "verify-nexus"), args, { env: env(run), stdio: "ignore" }),
    current: async () => (await readFile(join(base, "current"), "utf8").catch(() => null))?.trim() ?? null,
  };
}

const exited = (child: ReturnType<typeof spawn>) => new Promise<number | null>((done) => child.once("exit", (code, signal) => done(code ?? (signal === null ? null : 128))));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("down named for one run leaves another run's claim and stack alone", async (t) => {
  const v = await verifyCheckout(t);
  await mkdir(v.base, { recursive: true });
  await writeFile(join(v.base, "current"), "other\n");
  assert.equal(await exited(v.verify(["down"], "mine")), 0);
  assert.equal(await v.current(), "other");
});

test("an up stopped while its stack starts takes that stack down and releases the claim", async (t) => {
  const v = await verifyCheckout(t);
  const up = v.verify(["up"], "stopped");
  const pidFile = join(v.base, "runs", "stopped", "pid");
  while (!existsSync(pidFile)) await new Promise((done) => setTimeout(done, 20));
  const stack = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(alive(stack), "the stack started");
  up.kill("SIGTERM");
  assert.equal(await exited(up), 143);
  assert.equal(alive(stack), false, "the stack is stopped");
  assert.equal(await v.current(), null, "the claim is released");
});

test("down removes the run's template repository, which lives outside the run directory", async (t) => {
  const v = await verifyCheckout(t);
  const run = `mp-probe-test-${process.pid}-${Date.now()}`;
  const template = join("/var/tmp", `nexus-verify-${run}`);
  await mkdir(join(template, "template.git"), { recursive: true });
  t.after(() => rm(template, { recursive: true, force: true }));
  await mkdir(v.base, { recursive: true });
  await writeFile(join(v.base, "current"), `${run}\n`);
  assert.equal(await exited(v.verify(["down"], run)), 0);
  assert.equal(existsSync(template), false);
});
