import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./test-support/kit.ts";

const repo = new URL("..", import.meta.url).pathname;

/**
 * A checkout holding scripts/mp-probe.ts and a stand-in verify-nexus, which logs each call with the run name it was given.
 * Its `up` acts as FAKE_UP says: `lose` finds another probe's claim already made, `fail` claims and then fails, and
 * `hang` claims and waits.
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
  down*) rm -f ${base}/current ;;
esac
`, { mode: 0o755 });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const start = (up: "lose" | "fail" | "hang") => {
    const child = spawn(process.execPath, [join(root, "scripts", "mp-probe.ts"), "api"], { env: { ...process.env, FAKE_UP: up }, stdio: "ignore" });
    return { child, exit: new Promise<number | null>((done) => child.once("exit", (code) => done(code))) };
  };
  return {
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
