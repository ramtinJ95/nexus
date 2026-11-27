/**
 * The multiplayer arc's perf probe, which docs/multiplayer-plan.md's perf boxes compare against a baseline:
 *   node scripts/mp-probe.ts api           200 GET /v1/threads, alternating alice and bob, on a stack holding 50 threads
 *   node scripts/mp-probe.ts boot          POST /v1/threads to a running pylon whose resume exited, for a template boot
 *   node scripts/mp-probe.ts fresh-boot    POST /v1/threads on setup-change, whose .nexus/setup differs from main's, to a running pylon booted fresh
 *   node scripts/mp-probe.ts check [dir]   the wall time of .nexus/check, in the repo root or in `dir`
 *
 * It prints one JSON line on stdout and a summary on stderr, and exits 1 when anything it measured failed, so a run that
 * failed fast never reads as a fast run. `api` and `boot` start the verify-nexus stack themselves, refuse to run while
 * one is up, and always take theirs down, on a failure or a signal too.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const verifyNexus = join(root, ".claude/skills/verify-nexus/scripts/verify-nexus");
const stackBase = join(root, ".verify/nexus");
const seeded = 50;
const warmups = 20;
const timed = 200;
const requestTimeoutMs = 30_000;

type Result = Record<string, unknown> & { failed: number };

const ms = (ns: bigint) => Math.round(Number(ns) / 1e5) / 10;
const median = (sorted: readonly number[]) => sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : Math.round((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) * 5) / 10;
const nearestRank = (sorted: readonly number[], p: number) => sorted.length === 0 ? null : sorted[Math.ceil(p * sorted.length) - 1]!;
const sleep = (msecs: number) => new Promise((done) => setTimeout(done, msecs));

function revision(dir: string) {
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const head = git("rev-parse", "--short", "HEAD");
  if (head.status !== 0) throw new Error(`${dir} is not a git checkout: ${head.stderr.trim()}`);
  return { revision: head.stdout.trim(), dirty: git("status", "--porcelain", "--untracked-files=no").stdout.trim() !== "" };
}

/**
 * Starts the stack under a run name of its own, runs `body` against it, and takes it down whatever happens. A stack
 * that was up before is someone else's, so it is refused. `down` runs only while the claim names this probe's run,
 * so a probe that lost the claim to another never stops the other's stack.
 */
async function withStack(env: NodeJS.ProcessEnv, body: (state: StackState, run: string) => Promise<Result>): Promise<Result> {
  const current = join(stackBase, "current");
  if (existsSync(current)) throw new Error(`a verify-nexus stack is up, run ${readFileSync(current, "utf8").trim()}. The probe measures only a stack it starts itself`);
  const run = `probe-${Date.now()}-${process.pid}`;
  const ours = () => existsSync(current) && readFileSync(current, "utf8").trim() === run;
  /** Whether this probe's stack is down, so a run whose stack stays up is a failed one. */
  const down = () => !ours() || spawnSync(verifyNexus, ["down"], { stdio: ["ignore", 2, 2], env: { ...process.env, NEXUS_VERIFY_RUN: run } }).status === 0;
  const up = spawn(verifyNexus, ["up"], { stdio: ["ignore", 2, 2], env: { ...process.env, ...env, NEXUS_VERIFY_RUN: run } });
  const upExited = new Promise<number>((done, fail) => up.once("error", fail).once("exit", (c) => done(c ?? 1)));
  /** A stopped up takes its own run down, so the probe waits for it before making sure. */
  const stop = (signal: NodeJS.Signals) => {
    up.kill("SIGTERM");
    void upExited.catch(() => 1).then(() => { down(); process.exit(signal === "SIGINT" ? 130 : 143); });
  };
  process.once("SIGINT", stop).once("SIGTERM", stop);
  try {
    if (await upExited !== 0) throw new Error("verify-nexus up failed");
    const result = await body(JSON.parse(readFileSync(join(stackBase, "runs", run, "state.json"), "utf8")) as StackState, run);
    return down() ? result : { ...result, failed: result.failed + 1, error: `verify-nexus down failed, so run ${run} may still be up` };
  } finally {
    down();
    process.off("SIGINT", stop).off("SIGTERM", stop);
  }
}

interface StackState { api: string; bobApi: string; node: string; project: string; templateRepo: string }

/** One request on `agent`. The time is from the request's start to its body's end, and the body is parsed after. */
function send(url: string, agent: Agent, method = "GET", body?: unknown): Promise<{ status: number; body: unknown; ns: bigint }> {
  return new Promise((done, fail) => {
    const start = process.hrtime.bigint();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(url, { method, agent, headers: method === "GET" ? {} : { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const ns = process.hrtime.bigint() - start;
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* the status says what went wrong */ }
        done({ status: res.statusCode ?? 0, body: parsed, ns });
      });
      res.on("error", fail);
    });
    req.on("error", fail);
    req.setTimeout(requestTimeoutMs, () => req.destroy(new Error(`${method} ${url} sent no answer within ${requestTimeoutMs} ms`)));
    req.end(payload);
  });
}

async function api(): Promise<Result> {
  const people = { alice: new Agent({ keepAlive: true, maxSockets: 1 }), bob: new Agent({ keepAlive: true, maxSockets: 1 }) };
  try {
    return await withStack({ NEXUS_VERIFY_THREADS: String(seeded) }, async (state) => {
      const urls = { alice: state.api, bob: state.bobApi };
      for (const [person, id] of [["alice", "nALICE"], ["bob", "nBOB"]] as const) {
        const who = await send(`${urls[person]}/v1/whoami`, people[person]);
        if ((who.body as { node?: string }).node !== id) throw new Error(`whoami through ${urls[person]} names ${JSON.stringify(who.body)}, not ${id}`);
      }
      const first = await send(`${state.api}/v1/threads`, people.alice);
      const rows = first.body as { id: string; status: string; project: string }[];
      if (first.status !== 200 || !Array.isArray(rows) || rows.length !== seeded || !rows.every((t) => t.status === "archived" && t.project === state.project)) {
        throw new Error(`GET /v1/threads did not answer the ${seeded} seeded archived threads: HTTP ${first.status}, ${Array.isArray(rows) ? `${rows.length} rows` : JSON.stringify(first.body).slice(0, 200)}`);
      }
      const ids = new Set(rows.map((t) => t.id));
      const isSeed = (body: unknown) => Array.isArray(body) && body.length === seeded && body.every((t: { id?: string }) => ids.has(t.id!));
      const times: Record<"alice" | "bob", number[]> = { alice: [], bob: [] };
      const errors: string[] = [];
      for (let i = 0; i < warmups + timed; i++) {
        const person = i % 2 === 0 ? "alice" : "bob";
        try {
          const res = await send(`${urls[person]}/v1/threads`, people[person]);
          if (res.status !== 200 || !isSeed(res.body)) throw new Error(`HTTP ${res.status}${res.status === 200 ? ", not the seeded threads" : ""}`);
          if (i >= warmups) times[person].push(ms(res.ns));
        } catch (err) {
          if (i >= warmups) errors.push(`${person}: ${(err as Error).message}`);
        }
      }
      const all = [...times.alice, ...times.bob].sort((a, b) => a - b);
      const failed = errors.length;
      console.error(`api: ${all.length} of ${timed} GET /v1/threads answered the ${seeded} threads, median ${median(all)} ms, p95 ${nearestRank(all, 0.95)} ms${failed === 0 ? "" : `. ${failed} failed, the first: ${errors[0]}`}`);
      return {
        medianMs: median(all), p95Ms: nearestRank(all, 0.95), requests: timed, failed, threads: seeded,
        aliceMedianMs: median(times.alice.sort((a, b) => a - b)), bobMedianMs: median(times.bob.sort((a, b) => a - b)),
      };
    });
  } finally {
    people.alice.destroy();
    people.bob.destroy();
  }
}

interface Detail {
  thread: { id: string; status: string; setup?: { how: "template"; template: string } | { how: "fresh"; reason: string; building?: string } };
  pylon: { id: string; actualState: string; failed: string | null };
}

/** Polls `read` every `everyMs` until it returns a value, or throws once `seconds` pass, naming `what` and the last seen state. */
async function until<T>(what: string, seconds: number, everyMs: number, read: () => Promise<{ done: T } | { seen: string }>): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const r = await read();
    if ("done" in r) return r.done;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${seconds} s. Last seen: ${r.seen}`);
    await sleep(everyMs);
  }
}

/** With `branch`, the timed thread starts on it and must boot fresh, which runs setup and no resume, so it is timed to running. */
async function boot(branch?: string): Promise<Result> {
  const agent = new Agent({ keepAlive: true });
  try {
    return await withStack({}, async (state, run) => {
      const call = async (method: string, path: string, body?: unknown, expect = 200) => {
        const res = await send(`${state.api}${path}`, agent, method, body);
        if (res.status !== expect) throw new Error(`${method} ${path}: HTTP ${res.status}: ${JSON.stringify(res.body)}`);
        return res.body;
      };
      const detail = async (id: string) => await call("GET", `/v1/threads/${id}`) as Detail;
      const project = "ladle";
      // On a shared install a pylon boots with its owner's own logins, so alice signs in before the timed start.
      if (process.env.NEXUS_VERIFY_PEOPLE === "1") {
        await call("PUT", "/v1/logins/claude", { token: "sk-ant-oat01-mp-probe-made-up" });
        await call("PUT", "/v1/logins/github", { token: "ghp_verifyalice0mpprobe" });
        // mp-11's own host and secret, which a release before it answers 404 for and boots without.
        for (const [path, body] of [["/v1/own/hosts/mcp.alice.example", undefined], ["/v1/own/secrets/MCP_TOKEN", { value: "mp-probe-made-up", hosts: ["mcp.alice.example"] }]] as const) {
          const res = await send(`${state.api}${path}`, agent, "PUT", body);
          if (res.status !== 200 && res.status !== 404) throw new Error(`PUT ${path}: HTTP ${res.status}: ${JSON.stringify(res.body)}`);
        }
      }
      // The stack's spoon names a repository only its image holds, so the control plane cannot read its setup and every
      // spoon thread boots fresh. ladle names one both sides hold.
      await call("POST", "/v1/projects", {
        id: project, repoUrl: state.templateRepo, defaultBranch: "main", defaultNode: state.node,
        resources: { cpus: 1, memoryGiB: 3, diskGiB: 1 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
      }, 201);
      // A shared install starts a person's thread only on a pylon agent, so each start there names Claude Code.
      const brief = (title: string) => process.env.NEXUS_VERIFY_PEOPLE === "1" ? { claude: title } : { title };
      const warm = await call("POST", "/v1/threads", { project, ...brief("mp-probe: builds the template") }, 201) as Detail["thread"];
      const template = warm.setup?.how === "fresh" ? warm.setup.building : undefined;
      if (template === undefined) throw new Error(`the first ${project} thread asked for no template build: ${JSON.stringify(warm.setup)}`);
      console.error(`boot: ${warm.id} boots fresh and asked for template ${template}`);
      const registry = new DatabaseSync(join(stackBase, "runs", run, "registry.db"), { readOnly: true });
      try {
        await until(`template ${template} ready on ${state.node}`, 900, 2_000, async () => {
          const record = registry.prepare("SELECT record FROM templates WHERE id = ?").get(template)?.record as string | undefined;
          const t = record === undefined ? undefined : JSON.parse(record) as { state: string; logTail?: string };
          if (t?.state === "failed") throw new Error(`template ${template} failed to build: ${t.logTail}`);
          const observation = registry.prepare("SELECT observation FROM nodes WHERE name = ?").get(state.node)?.observation as string | null | undefined;
          const held = observation != null && (JSON.parse(observation) as { artifacts?: string[] }).artifacts?.includes(template) === true;
          return t?.state === "ready" && held ? { done: true } : { seen: `${t?.state ?? "no record"}, ${held ? "" : "not "}held by the node` };
        });
      } finally {
        registry.close();
      }
      await call("DELETE", `/v1/threads/${warm.id}`);
      await until(`${warm.id}'s pylon gone`, 300, 1_000, async () => {
        const d = await detail(warm.id);
        return d.pylon.actualState === "absent" ? { done: true } : { seen: d.pylon.actualState };
      });

      const start = process.hrtime.bigint();
      const timedThread = await call("POST", "/v1/threads", { project, ...brief(`mp-probe: boots ${branch === undefined ? "from the template" : `fresh on ${branch}`}`), ...branch === undefined ? {} : { branch } }, 201) as Detail["thread"];
      try {
        if (branch !== undefined) {
          if (timedThread.setup?.how !== "fresh") throw new Error(`${timedThread.id} on ${branch} does not boot fresh: ${JSON.stringify(timedThread.setup)}`);
          const reason = timedThread.setup.reason;
          await until(`${timedThread.id} running fresh`, 900, 250, async () => {
            const d = await detail(timedThread.id);
            if (d.pylon.failed !== null) throw new Error(`${timedThread.id}'s pylon failed: ${d.pylon.failed}`);
            return d.pylon.actualState === "running" ? { done: true } : { seen: d.pylon.actualState };
          });
          const bootMs = ms(process.hrtime.bigint() - start);
          console.error(`fresh-boot: ${timedThread.id} on ${branch} ran fresh (${reason}), ${bootMs} ms after POST /v1/threads`);
          return { bootMs, branch, reason, failed: 0 };
        }
        if (timedThread.setup?.how !== "template" || timedThread.setup.template !== template) throw new Error(`${timedThread.id} does not boot from template ${template}: ${JSON.stringify(timedThread.setup)}`);
        const booted = await until(`${timedThread.id} running from its template with its resume exited`, 600, 250, async () => {
          const d = await detail(timedThread.id);
          if (d.pylon.failed !== null) throw new Error(`${timedThread.id}'s pylon failed: ${d.pylon.failed}`);
          if (d.pylon.actualState !== "running" || d.thread.setup?.how !== "template") return { seen: `${d.pylon.actualState}, setup ${d.thread.setup?.how ?? "none"}` };
          // The API does not report the resume, and the Docker backend logs its outcome in the container log.
          const log = spawnSync("docker", ["logs", d.pylon.id], { encoding: "utf8" });
          const exit = /^resume: exited (\d+)/m.exec(`${log.stdout}${log.stderr}`)?.[1];
          if (exit === undefined) return { seen: "running, resume not exited" };
          if (exit !== "0") throw new Error(`${timedThread.id}'s resume exited ${exit}`);
          return { done: { ns: process.hrtime.bigint() - start, setup: d.thread.setup } };
        });
        if (booted.setup?.how !== "template") throw new Error(`${timedThread.id} reads ${JSON.stringify(booted.setup)} once running`);
        const bootMs = ms(booted.ns);
        console.error(`boot: ${timedThread.id} ran from template ${template} with its resume exited 0, ${bootMs} ms after POST /v1/threads`);
        return { bootMs, template, failed: 0 };
      } finally {
        await call("DELETE", `/v1/threads/${timedThread.id}`).catch((err: unknown) => console.error(`boot: deleting ${timedThread.id} failed: ${(err as Error).message}`));
      }
    });
  } finally {
    agent.destroy();
  }
}

async function check(dir: string): Promise<Result> {
  const script = join(dir, ".nexus/check");
  if (!existsSync(script)) throw new Error(`${dir} has no .nexus/check`);
  const start = process.hrtime.bigint();
  const exitCode = await new Promise<number>((done, fail) => spawn(script, [], { cwd: dir, stdio: ["ignore", 2, 2] }).once("error", fail).once("exit", (code) => done(code ?? 1)));
  const wallMs = ms(process.hrtime.bigint() - start);
  console.error(`check: .nexus/check in ${dir} exited ${exitCode} after ${wallMs} ms`);
  return { dir, wallMs, exitCode, failed: exitCode === 0 ? 0 : 1 };
}

const [probe, ...rest] = process.argv.slice(2);
const dir = resolve(rest[0] ?? root);
const runs: Record<string, () => Promise<Result>> = { api, boot: () => boot(), "fresh-boot": () => boot("setup-change"), check: () => check(dir) };
if (probe === undefined || !Object.hasOwn(runs, probe) || rest.length > (probe === "check" ? 1 : 0)) {
  console.error("usage: node scripts/mp-probe.ts api | boot | fresh-boot | check [dir]");
  process.exit(64);
}
let measured: Record<string, unknown> & Result;
try {
  // The revision is read first, so the line names the code that was measured even if the run changes the tree.
  const at = revision(probe === "check" ? dir : root);
  measured = { ...at, ...await runs[probe]!() };
} catch (err) {
  console.error(`${probe}: ${(err as Error).message}`);
  measured = { failed: probe === "api" ? timed : 1, error: (err as Error).message };
}
console.log(JSON.stringify({ probe, ...measured }));
process.exit(measured.failed > 0 ? 1 : 0);
