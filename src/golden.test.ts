/**
 * Golden captures: the API's JSON, the CLI's text and --json, the dashboard's pages and the first frames of its
 * streams, read from the demo's world (dashboard/demo-fixtures.ts, with golden/reviews.ts's reviews) under a stopped
 * clock, each kept as a file under src/golden/. Then the main writes, one capture each, in order, and a refusal of
 * each role. A change that keeps behavior leaves every file as it is.
 *
 * Each random ID shows as the seed's name for it, which can be wider or narrower than the ID, so a column of IDs in
 * the CLI's text need not line up. Floats keep 9 significant digits, since SQLite's float sums differ in the last bit
 * between platforms, and a long array of numbers shows as its count, ends, range and a few samples.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const now = "2027-01-15T12:00:00.000Z";
process.env.NEXUS_GOLDEN_NOW = now;
process.env.TZ = "UTC";
// The demo checkout's commits, and so their hashes, are the same on each run.
process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = now;
await import("./golden/frozen.ts");
const { deployToken, laptop, phone, reporterHeaders, testApi } = await import("./control/api-test-kit.ts");
const { tokenDigest } = await import("./deploy/model.ts");
const { tempDir } = await import("./test-kit.ts");
const { demoCheckout, demoProbes, demoReviews, seedDemo } = await import("./control/dashboard/demo-fixtures.ts");
const { seedReviews } = await import("./golden/reviews.ts");
const { utc } = await import("./control/usage.ts");
const { version } = await import("./version.ts");
const { openTerminal, terminalSize } = await import("./guest-terminal.ts");
const { processStream } = await import("./process-stream.ts");
type TailnetNodeId = import("./ids.ts").TailnetNodeId;

const repo = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("./golden/", import.meta.url));
const frozen = fileURLToPath(new URL("./golden/frozen.ts", import.meta.url));
const runner = fileURLToPath(new URL("./golden/cli-runner.ts", import.meta.url));
const cli = fileURLToPath(new URL("./cli/nexus.ts", import.meta.url));
const update = process.env.NEXUS_GOLDEN_UPDATE === "1";
const run = promisify(execFile);
const hour = 3_600_000;
const day = 24 * hour;
/** rj-firebat's tailnet ID once the demo observes it. */
const node = "nRJ-FIREBAT" as TailnetNodeId;

/** One golden file: where it lives under src/golden/, and what reads its text now, until `signal` aborts. */
interface Capture { file: string; read(signal: AbortSignal): Promise<string> }

test("the API, the CLI and the dashboard answer the demo world as their golden captures record", async (t) => {
  // A check must fail on a changed capture, never rewrite it.
  assert.ok(!update || (process.env.CI === undefined && process.env.NEXUS_CHECK === undefined), "NEXUS_GOLDEN_UPDATE=1 is refused where CI or NEXUS_CHECK is set");
  const context = { after: (close: () => unknown) => t.after(close) } as never as import("node:test").TestContext;
  const checkout = await demoCheckout();
  t.after(() => rm(checkout, { recursive: true, force: true }));
  let report: () => import("./control/doctor-model.ts").DoctorReport | null = () => null;
  const s = await testApi(context, {
    pipeline: true, planning: true, probes: demoProbes(() => s.registry, checkout),
    allowed: new Set([laptop, phone, node]),
    deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: { [node]: tokenDigest(deployToken) } },
    health: () => report(),
    doctor: async () => report()!,
    reviews: { ...demoReviews(() => s.registry), answerHolds },
  });
  /** As the demo's review loop does with a land: a Land answer waives the holds it names and starts merging, and nothing reaches GitHub. */
  function answerHolds(question: import("./control/questions.ts").ThreadQuestion & { holds: import("./control/questions.ts").HeldQuestion }, option: string, by: TailnetNodeId) {
    const answered = s.registry.answerQuestion(question.id, { option, by, at: Date.now() });
    const r = s.registry.review(question.thread)!;
    if (option === "Land") {
      const waiver = { head: question.holds.head, holds: question.holds.holds.map((h) => h.text), codes: question.holds.holds.map((h) => h.code), by, at: Date.now() };
      s.registry.saveReview({ ...r, waiver, land: { requestedBy: by }, phase: { kind: "merging", authorized: null } }, [], r);
    }
    return answered;
  }
  // The demo's probes refuse transcript reads, which the control plane logs once per Claude pylon. The captures show the refusal.
  const log = console.error;
  console.error = (...args: unknown[]) => { if (!String(args[0]).includes("reading Claude's transcript failed")) log(...args); };
  t.after(() => { console.error = log; });
  // The demo seeds 31 days of five-minute samples, which cost most of this test's time. Every half hour of them still
  // fills each tier the metrics serve from.
  const record = s.registry.recordHealthSample.bind(s.registry);
  s.registry.recordHealthSample = (n, sample) => sample.at < Date.now() - 6 * hour && sample.at % (30 * 60_000) !== 0 ? false : record(n, sample);
  const demo = await seedDemo(s);
  demo.stop();
  report = demo.health;
  const threads = [...demo.world.threads, ...await seedReviews(s)];

  const id = (key: string) => threads.find(([k]) => k === key)![1].id;
  const queued = s.registry.queuedThreads().filter((q) => q.status === "queued");
  const items = s.registry.items();
  const nodes = s.registry.nodes().map((n) => n.name);
  const projects = s.registry.projects().map((p) => p.id);
  /** An answer of the last option to the thread's first open question. */
  const answerLast = (key: string) => {
    const q = s.registry.questions(id(key)).find((q) => q.answer === null)!;
    return api(`/v1/questions/${encodeURIComponent(q.id)}/answer`, "POST", { option: q.options.at(-1) });
  };
  const checked = id("graphs");
  const peeked = ["graphs", "attach", "plan", "applepay-review", "alerts", "cert", "banner"];
  const home = await tempDir("nexus-golden-home-", t);
  const scratch = await tempDir("nexus-golden-diff-", t);

  /** Each random ID by what the seed calls it, or by its place in the seed, so a capture reads the same on each run. */
  const named = new Map<string, string>([
    ...threads.map(([key, thread]): [string, string] => [thread.id, `th-${key}`]),
    ...queued.map((q, i): [string, string] => [q.id, `th-queued-${i + 1}`]),
    ...items.filter((i) => /^it-[0-9a-f]{12}$/.test(i.id)).map((item, i): [string, string] => [item.id, `it-added-${i + 1}`]),
  ]);
  for (const [i, thread] of s.registry.threads().filter((t) => !named.has(t.id)).entries()) named.set(thread.id, `th-seeded-${i + 1}`);
  /** Set while the writes run, which alone mint IDs, one write at a time, so each new ID is named in the order it appears. */
  let minting = false;
  // The registry's first migration takes it from SQLite's clock, which is the host's.
  const countingSince: number = JSON.parse((await s.raw("/v1/usage")).body.toString()).countingSince;
  const normal = (text: string) => {
    let out = !minting ? text : text.replace(/\b(th|it)-[0-9a-f]{12}\b/g, (found, kind: string) => {
      if (found !== "th-000000000000" && !named.has(found)) named.set(found, `${kind}-new-${named.size + 1}`);
      return found;
    });
    for (const [from, to] of named) out = out.replaceAll(from, to);
    return out
      .replaceAll(String(countingSince), "<counting since>")
      .replaceAll(new Date(countingSince).toISOString(), "<counting since>")
      .replaceAll(utc(countingSince), "<counting since>")
      // A release bumps it, which is not a change of behavior.
      .replaceAll(`nexus ${version}`, "nexus <version>")
      .replaceAll(`"version": "${version}"`, `"version": "<version>"`)
      .replaceAll(`127.0.0.1:${s.port}`, "127.0.0.1:API")
      // The bundles' hashes, which build.test.ts covers, so a client change does not touch every page.
      .replace(/(\/assets\/[\w.-]+)\?v=[0-9a-f]+/g, "$1?v=<hash>")
      .replace(/-?\d+\.\d{10,}/g, (n) => String(Number(Number(n).toPrecision(9))))
      .replaceAll(checkout, "<checkout>")
      .replaceAll(home, "<home>")
      .replaceAll(repo, "<repo>/")
      .replaceAll(tmpdir(), "<tmp>");
  };

  /** A diff between two texts, from its first hunk, as `git diff` gives it. */
  let diffs = 0;
  async function unified(before: string, after: string, context = 3): Promise<string> {
    const [a, b] = [join(scratch, `${++diffs}.a`), join(scratch, `${diffs}.b`)];
    await writeFile(a, before);
    await writeFile(b, after);
    const out = await run("git", ["diff", "--no-index", "--no-color", `-U${context}`, "--", a, b]).then(() => "", (err: { code: number; stdout: string }) => {
      if (err.code !== 1) throw err;
      return err.stdout;
    });
    return out.slice(out.indexOf("@@"));
  }

  const call = (method: string, path: string, body?: unknown, signal?: AbortSignal, headers: Record<string, string> = {}) => new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
    request({
      host: "127.0.0.1", port: s.port, method, path, agent: false, signal,
      headers: { host: `127.0.0.1:${s.port}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"] ?? ""), text }));
    }).on("error", reject).end(body === undefined ? undefined : JSON.stringify(body));
  });
  const reply = (r: { status: number; type: string; text: string }) =>
    `${r.status} ${r.type}\n${r.type.startsWith("application/json") ? json(r.text) : r.text}\n`;

  const api = (path: string, method = "GET", body?: unknown, headers?: Record<string, string>): Capture => ({
    file: `api/${method === "GET" ? "" : `${method}-`}${slug(path)}.json`,
    read: async (signal) => reply(await call(method, path, body, signal, headers)),
  });
  const page = (path: string): Capture => ({
    file: `pages/${slug(path)}.html`,
    async read(signal) {
      const r = await call("GET", path, undefined, signal);
      return `${r.status} ${r.type}\n${r.type.startsWith("text/html") ? pretty(r.text) : r.text}\n`;
    },
  });
  /** A page that is the home page with one region added or changed: what differs from pages/index.html. */
  const variant = (path: string): Capture => ({
    file: `pages/${slug(path)}.diff`,
    async read(signal) {
      const [base, r] = [await call("GET", "/", undefined, signal), await call("GET", path, undefined, signal)];
      return `${r.status} ${r.type}\nwhat differs from pages/index.html:\n${await unified(pretty(base.text), pretty(r.text))}`;
    },
  });
  /** The first `frames` frames of a server-sent event stream, or its frames up to its first ping. */
  const stream = (path: string, frames: number | "ping"): Capture => ({
    file: `streams/${slug(path)}.txt`,
    read: (signal) => new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: s.port, path, agent: false, signal, headers: { host: `127.0.0.1:${s.port}`, accept: "text/event-stream" } }, (res) => {
        let text = "";
        const done = (blocks: string[]) => {
          req.destroy();
          resolve(`${res.statusCode} ${res.headers["content-type"] ?? ""}\n${blocks.map((block) => block.split("\n").map((line) => line.startsWith("data: ") ? `data: ${json(line.slice(6))}` : line).join("\n")).join("\n\n")}\n`);
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          const blocks = text.split("\n\n").slice(0, -1);
          const end = frames === "ping" ? blocks.findIndex((b) => b.includes(": ping")) : blocks.filter((b) => b.includes("data: ")).length >= frames ? blocks.length - 1 : -1;
          if (end !== -1) done(blocks.slice(0, end + 1));
        });
        res.on("end", () => done([text]));
      });
      req.on("error", (err) => { if (!signal.aborted && err.name !== "AbortError") reject(err); });
      req.end();
    }),
  });

  const runners = await Promise.all([0, 1].map(() => cliRunner(t, { PATH: process.env.PATH!, HOME: home, TZ: "UTC", NEXUS_GOLDEN_NOW: now, NEXUS_URL: `http://127.0.0.1:${s.port}`, NEXUS_SOCKS: "none" })));
  let turn = 0;
  const nexus = (...args: string[]): Capture => ({
    file: `cli/${slug(args.join(" "))}.txt`,
    async read(signal) {
      const r = await runners[turn++ % runners.length]!(args, signal);
      const stdout = args.includes("--json") && r.stdout.trim() !== "" ? `${json(r.stdout)}\n` : r.stdout;
      return `exit ${r.code}\n--- stdout\n${stdout}--- stderr\n${r.stderr}`;
    },
  });
  /** The command as text and as --json. */
  const both = (...args: string[]) => [nexus(...args), nexus(...args, "--json")];
  /** The command in a terminal of its own, which gets `answer` once its screen shows `prompt`. */
  const typed = (args: string[], prompt: string, answer: string): Capture => ({
    file: `cli/${slug(args.join(" "))}.screen.txt`,
    async read() {
      const env = { PATH: process.env.PATH!, HOME: home, TZ: "UTC", NEXUS_GOLDEN_NOW: now, NEXUS_URL: `http://127.0.0.1:${s.port}`, NEXUS_SOCKS: "none" };
      const terminal = await openTerminal(async (argv) => processStream(argv[0]!, argv.slice(1), () => {}), terminalSize(200, 50), "dumb",
        ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--import", frozen, cli, ...args]);
      let screen = "";
      let answered = false;
      for await (const chunk of terminal) {
        screen += Buffer.from(chunk).toString();
        if (!answered && screen.includes(prompt)) {
          answered = true;
          await terminal.write(Buffer.from(`${answer}\r`));
        }
      }
      const end = await terminal.done;
      return `exit ${end.kind === "exited" ? end.code : end.kind}\n--- screen\n${screen.replaceAll("\r\n", "\n")}`;
    },
  });
  /** A capture made as another caller: the API's whois names `caller` until it ends. */
  const as = (caller: TailnetNodeId, who: string, c: Capture): Capture => ({
    file: c.file.replace(/^(\w+)\//, `$1/as-${who}-`),
    async read(signal) {
      s.callAs(caller);
      try { return await c.read(signal); } finally { s.callAs(laptop); }
    },
  });

  const reads: Capture[] = [
    ...[
      "/v1/health", "/v1/whoami", "/v1/projects", "/v1/nodes", "/v1/images", "/v1/images/current", "/v1/release", "/v1/deployer/release",
      "/v1/threads", "/v1/threads?deleted=false", "/v1/threads?project=storefront", "/v1/queued", "/v1/items", "/v1/items?project=nexus",
      "/v1/events", "/v1/events?project=field-notes", "/v1/events?kind=thread.turn-ended", "/v1/events?kind=attention.changed&kind=thread.failed", "/v1/checks", "/v1/checks/changes", "/v1/doctor",
      "/v1/usage", "/v1/usage?since=7d", "/v1/usage?since=30d&by=model&by=day", "/v1/usage?since=today&project=nexus", "/v1/usage?since=2027-01-10", "/v1/usage/backfill",
      "/v1/threads/th-000000000000", "/v1/nosuch",
    ].map((path) => api(path)),
    ...threads.flatMap(([, thread]) => [api(`/v1/threads/${thread.id}`), api(`/v1/threads/${thread.id}/conversation`), api(`/v1/events?thread=${thread.id}`)]),
    ...queued.map((q) => api(`/v1/queued/${q.id}`)),
    ...items.map((i) => api(`/v1/items/${i.id}`)),
    ...nodes.flatMap((n) => [
      api(`/v1/nodes/${n}/health`),
      api(`/v1/nodes/${n}/metrics?from=${Date.now() - hour}`), api(`/v1/nodes/${n}/metrics?from=${Date.now() - day}`),
      api(`/v1/nodes/${n}/metrics?from=${Date.now() - 31 * day}&to=${Date.now() - 30 * day}`), api(`/v1/nodes/${n}/metrics`),
    ]),

    ...["/", "/pipeline", "/cluster", "/health", "/usage", "/usage?period=today", "/usage?period=30d", "/usage?period=all", "/usage?project=nexus", "/threads/th-000000000000", "/nodes/nosuch"].map(page),
    ...["/threads/new", "/threads/new?project=storefront", "/projects/new"].map(variant),
    ...threads.map(([, thread]) => page(`/threads/${thread.id}`)),
    ...threads.filter(([key]) => peeked.includes(key) || key.startsWith("rv-")).map(([, thread]) => variant(`/?peek=${thread.id}`)),
    ...queued.flatMap((q) => [page(`/threads/${q.id}`), variant(`/?peek=${q.id}`)]),
    ...items.map((i) => variant(`/?peek=${i.id}`)),
    ...nodes.map((n) => page(`/nodes/${n}`)),

    stream(`/threads/${checked}/stream`, 1), stream(`/threads/${id("attach")}/stream`, 1),
    stream(`/v1/threads/${checked}/events`, 1), stream(`/v1/threads/${id("attach")}/claude/events`, 1),
    stream("/v1/events?follow=true&project=field-notes", "ping"),

    nexus("--help"), nexus("--version"), nexus("nosuch"),
    ...both("projects"), ...both("nodes"), ...both("release"), ...both("doctor"), ...both("items"), ...both("items", "--all"),
    ...both("threads"), ...both("threads", "--all"), ...both("threads", "--queued"), ...both("threads", "--project", "storefront"),
    ...both("image", "list"), ...both("image", "current"), ...both("events", "--project", "field-notes"),
    ...both("usage"), ...both("usage", "--since", "all"), ...both("usage", "--by", "model"), ...both("usage", "--by", "day"), ...both("usage", "--by", "role"),
    ...both("usage", "backfill", "--dry-run"),
    ...projects.flatMap((p) => both("project", "show", p)),
    ...nodes.flatMap((n) => both("node", n)),
    ...items.flatMap((i) => both("item", "show", i.id)),
    ...threads.flatMap(([, thread]) => [...both("show", thread.id), nexus("conversation", thread.id)]),
    ...both("show", "th-000000000000"),
  ];
  // A read of the pylon's checkout records a human's visit to its thread, so these run after the reads above.
  const visits: Capture[] = [
    ...[
      `/v1/threads/${checked}/files`, `/v1/threads/${checked}/files?path=src`, `/v1/threads/${checked}/files/content?path=src/backoff.ts`,
      `/v1/threads/${checked}/changes`, `/v1/threads/${checked}/changes?base=head`, `/v1/threads/${checked}/changes?base=turn`,
      `/v1/threads/${checked}/diff`, `/v1/threads/${checked}/diff?base=head&path=README.md`,
    ].map((path) => api(path)),
    ...both("ports", checked), ...both("files", checked), ...both("files", checked, "src"),
    ...both("changes", checked), ...both("changes", checked, "--uncommitted"), ...both("changes", checked, "--turn"),
    ...both("diff", checked), ...both("diff", checked, "README.md"),
  ];
  // Each changes the world, so they run one at a time in this order, after every read.
  const writes: Capture[] = [
    as(node, "deployer-node", api("/v1/deployer/release", "GET", undefined, reporterHeaders)),
    nexus("start", "--project", "storefront", "--title", "Golden start", "--message", "Add a footer"),
    nexus("start", "--project", "nexus", "--title", "Golden JSON start", "--json"),
    nexus("start", "--project", "nosuch"), nexus("start", "--project", "nexus", "--title", "No CPUs", "--cpus", "0"),
    api("/v1/threads", "POST", { project: "nexus", title: 7 }),
    nexus("send", id("spin"), "Keep", "going"), nexus("send", id("flaky"), "Rebase", "it", "--json"),
    nexus("seen", id("sync")), nexus("seen", id("sync"), "--unread", "--json"),
    nexus("archive", id("dark")), nexus("archive", id("inventory"), "--json"), nexus("unarchive", id("dark")),
    nexus("delete", id("fts")), api(`/v1/threads/${id("crash")}`, "DELETE"),
    answerLast("cert"), answerLast("plan"),
    nexus("review", id("flaky")), nexus("review", "--cancel", id("rounding")), api(`/v1/threads/${id("applepay")}/review/cancel`, "POST", {}),
    nexus("land", id("rv-approved")),
    typed(["land", id("rv-needs-person-holds"), "--waive"], "Type yes", "yes"),
    api(`/v1/threads/${id("rv-merging")}/land`, "POST", {}),
    nexus("item", "add", "--project", "storefront", "--title", "Golden item", "--message", "Brief: a golden item."),
    nexus("item", "approve", "it-giftcards"), nexus("item", "cancel", "it-cleanup", "--json"),
    nexus("project", "add", "golden", "https://github.com/ramtinJ95/golden.git"),
    nexus("project", "edit", "storefront", "--cpus", "4"), nexus("project", "edit", "field-notes", "--allow-host", "example.org", "--json"),
    nexus("deploy", "main"), api("/v1/release", "PUT", { commit: "a".repeat(40) }),
    as(phone, "person", nexus("deploy", "a".repeat(40))), as(phone, "person", api("/v1/release", "PUT", { commit: "a".repeat(40) })),
    as(node, "node", nexus("start", "--project", "nexus", "--title", "From a node")), as(node, "node", api(`/v1/threads/${id("sync")}/archive`, "POST", {})),
    ...[...both("threads", "--all"), api("/v1/events?kind=thread.archived")].map((c) => ({ ...c, file: c.file.replace(/^(\w+)\//, "$1/after-writes-") })),
  ];

  const read = (c: Capture) => within(c).then(normal);
  const texts = [...await pool(reads, 8, read), ...await pool(visits, 8, read)];
  minting = true;
  texts.push(...await pool(writes, 1, read));
  const all = [...reads, ...visits, ...writes];
  const wanted = new Map(all.map((c, i) => [normal(c.file), texts[i]!]));
  assert.equal(wanted.size, all.length, "every capture has its own file");

  const kept = await files(root);
  if (update) {
    for (const file of kept) if (!wanted.has(file)) await rm(join(root, file));
    for (const [file, text] of wanted) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
    return;
  }
  const changed: { file: string; diff: string }[] = [];
  for (const [file, text] of wanted) {
    const golden = await readFile(join(root, file), "utf8").catch(() => null);
    if (golden !== text) changed.push({ file, diff: golden === null ? "(new)" : await unified(golden, text, 2) });
  }
  for (const file of kept) if (!wanted.has(file)) changed.push({ file, diff: "(no longer captured)" });
  const shown = changed.slice(0, 5).map(({ file, diff }) => {
    const lines = diff.split("\n");
    return `--- ${file}\n${lines.slice(0, 40).join("\n")}${lines.length > 40 ? `\n... ${lines.length - 40} more lines` : ""}`;
  });
  assert.equal(changed.length, 0, `${changed.length} captures differ from src/golden/: ${changed.map((c) => c.file).join(", ")}

${shown.join("\n\n")}

Update them only when the change means to alter this behavior and its PR says how: run NEXUS_GOLDEN_UPDATE=1 node --test src/golden.test.ts and commit src/golden/. Otherwise the change broke behavior it should keep.`);
});

/** JSON text as the captures keep it: two-space indents, 9 significant digits, and long arrays of numbers summed up. */
function json(text: string): string {
  const tidy = (value: unknown): unknown => {
    if (typeof value === "number") return Number.isInteger(value) ? value : Number(value.toPrecision(9));
    if (Array.isArray(value)) {
      if (value.length > 16 && value.every((v) => v === null || typeof v === "number")) {
        const numbers = value.filter((v): v is number => v !== null);
        const at = (i: number) => tidy(value[Math.round((i * (value.length - 1)) / 4)]);
        return { count: value.length, nulls: value.length - numbers.length, first: tidy(value[0]), last: tidy(value.at(-1)), min: tidy(Math.min(...numbers)), max: tidy(Math.max(...numbers)), samples: [0, 1, 2, 3, 4].map(at) };
      }
      return value.map(tidy);
    }
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tidy(v)]));
    return value;
  };
  try {
    return JSON.stringify(tidy(JSON.parse(text)), null, 2);
  } catch {
    return text;
  }
}

/** HTML with each tag on its own line, so one changed label is one changed line. */
const pretty = (html: string) => html.replaceAll("><", ">\n<");

/**
 * A CLI runner: a process of cli-runner.ts, which runs one command at a time. Returns what runs a command in it,
 * killing the runner if `signal` aborts first.
 */
async function cliRunner(t: import("node:test").TestContext, env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", frozen, runner], { env, stdio: ["pipe", "inherit", "inherit", "pipe"] });
  t.after(() => { child.kill(); });
  const replies = createInterface({ input: child.stdio[3] as import("node:stream").Readable });
  const waiting: ((line: string) => void)[] = [];
  replies.on("line", (line) => waiting.shift()?.(line));
  let last = Promise.resolve();
  return (args: string[], signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> => {
    const result = last.then(() => new Promise<string>((resolve) => {
      waiting.push(resolve);
      child.stdin!.write(`${JSON.stringify({ args })}\n`);
      signal.addEventListener("abort", () => child.kill(), { once: true });
    })).then((line) => JSON.parse(line));
    last = result.then(() => {}, () => {});
    return result;
  };
}

/** A capture's text, or a failure that names it if it has not answered in 60 s, as a hang would. Its reads stop then. */
async function within(c: Capture): Promise<string> {
  const late = AbortSignal.timeout(60_000);
  const timedOut = new Promise<never>((_, reject) => late.addEventListener("abort", () => reject(new Error(`${c.file} did not answer in 60 s`))));
  return Promise.race([c.read(late), timedOut]);
}

/** A path or command line as a file name: `/v1/threads?all=true` is `v1-threads_all=true`, and `threads --all --json` is `threads-all-json`. */
function slug(text: string): string {
  return text.replace(/^[/-]+/, "").replace(/ -+/g, " ").replace(/\?/g, "_").replace(/[^\w.=-]+/g, "-").replace(/^$/, "index");
}

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && !e.name.endsWith(".ts")).map((e) => relative(dir, join(e.parentPath, e.name)));
}

/** Runs `work` over `inputs` with at most `width` at once, the results in input order. After a failure it starts no more. */
async function pool<T, R>(inputs: readonly T[], width: number, work: (input: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < inputs.length) {
      const i = next++;
      try {
        results[i] = await work(inputs[i]!);
      } catch (err) {
        next = inputs.length;
        throw err;
      }
    }
  }));
  return results;
}
