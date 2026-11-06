/**
 * Golden captures: the API's JSON, the CLI's text and --json, and every dashboard page, read from the demo's world
 * (dashboard/demo-fixtures.ts) under a stopped clock, each kept as a file under src/golden/. A change that keeps
 * behavior leaves them all as they are. Run with NEXUS_GOLDEN_UPDATE=1 to write what the code gives now, then read
 * the git diff of src/golden/ as the change's behavior diff. Each random ID shows as the seed's name for it, which
 * can be wider or narrower than the ID, so a column of IDs in the CLI's text need not line up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const now = "2027-01-15T12:00:00.000Z";
process.env.NEXUS_GOLDEN_NOW = now;
process.env.TZ = "UTC";
// The demo checkout's commits, and so their hashes, are the same on each run.
process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = now;
await import("./golden/frozen.ts");
const { laptop, tempDir, testApi } = { ...await import("./control/api-test-kit.ts"), ...await import("./test-kit.ts") };
const { demoCheckout, demoProbes, demoReviews, seedDemo } = await import("./control/dashboard/demo-fixtures.ts");
const { utc } = await import("./control/usage.ts");
const { version } = await import("./version.ts");
type TailnetNodeId = import("./ids.ts").TailnetNodeId;

const root = fileURLToPath(new URL("./golden/", import.meta.url));
const frozen = fileURLToPath(new URL("./golden/frozen.ts", import.meta.url));
const cli = fileURLToPath(new URL("./cli/nexus.ts", import.meta.url));
const update = process.env.NEXUS_GOLDEN_UPDATE === "1";

const hour = 3_600_000;
const day = 24 * hour;

/** One golden file: where it lives under src/golden/, and what reads its text now, until `signal` aborts. */
interface Capture { file: string; read(signal: AbortSignal): Promise<string> }

test("the API, the CLI and the dashboard answer the demo world as their golden captures record", async (t) => {
  const context = { after: (close: () => unknown) => t.after(close) } as never as import("node:test").TestContext;
  const checkout = await demoCheckout();
  t.after(() => rm(checkout, { recursive: true, force: true }));
  let report: () => import("./control/doctor-model.ts").DoctorReport | null = () => null;
  const s = await testApi(context, {
    pipeline: true, planning: true, probes: demoProbes(() => s.registry, checkout),
    deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
    health: () => report(),
    doctor: async () => report()!,
    reviews: demoReviews(() => s.registry),
  });
  const demo = await seedDemo(s);
  demo.stop();
  report = demo.health;

  const threads = [...demo.world.threads];
  const queued = s.registry.queuedThreads().filter((q) => q.status === "queued");
  const items = s.registry.items();
  const nodes = s.registry.nodes().map((n) => n.name);
  const projects = s.registry.projects().map((p) => p.id);
  const checked = threads.find(([key]) => key === "graphs")![1];
  const peeked = ["graphs", "attach", "plan", "applepay-review", "alerts", "cert", "banner"];
  const home = await tempDir("nexus-golden-home-", t);

  /** Each random ID by what the seed calls it, or by its place in the seed, so a capture reads the same on each run. */
  const named: [string, string][] = [
    ...threads.map(([key, thread]): [string, string] => [thread.id, `th-${key}`]),
    ...queued.map((q, i): [string, string] => [q.id, `th-queued-${i + 1}`]),
    ...items.filter((i) => /^it-[0-9a-f]{12}$/.test(i.id)).map((item, i): [string, string] => [item.id, `it-added-${i + 1}`]),
  ];
  // The registry's first migration takes it from SQLite's clock, which is the host's.
  const countingSince: number = JSON.parse((await s.raw("/v1/usage")).body.toString()).countingSince;
  const normal = (text: string) => {
    let out = text;
    for (const [id, name] of named) out = out.replaceAll(id, name);
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
      .replaceAll(checkout, "<checkout>")
      .replaceAll(home, "<home>")
      .replaceAll(tmpdir(), "<tmp>");
  };

  const api = (path: string): Capture => ({
    file: `api/${slug(path)}.json`,
    async read() {
      const res = await s.raw(path);
      const type = String(res.headers["content-type"] ?? "");
      const body = type.startsWith("application/json") ? JSON.stringify(JSON.parse(res.body.toString()), null, 2) : res.body.toString();
      return `${res.status} ${type}\n${body}\n`;
    },
  });
  const page = (path: string): Capture => ({
    file: `pages/${slug(path)}.html`,
    async read() {
      const res = await s.raw(path);
      const location = res.headers.location === undefined ? "" : `location: ${res.headers.location}\n`;
      return `${res.status} ${res.headers["content-type"] ?? ""}\n${location}${res.body.toString()}\n`;
    },
  });
  const nexus = (args: string[]): Capture => ({
    file: `cli/${slug(args.join(" "))}.txt`,
    read: (signal) => new Promise((resolve) => execFile(process.execPath, ["--import", frozen, cli, ...args], {
      signal, env: { PATH: process.env.PATH!, HOME: home, TZ: "UTC", NEXUS_GOLDEN_NOW: now, NEXUS_URL: `http://127.0.0.1:${s.port}`, NEXUS_SOCKS: "none" },
    }, (err, stdout, stderr) => resolve(`exit ${err === null ? 0 : err.code}\n--- stdout\n${stdout}--- stderr\n${stderr}`))),
  });
  /** The command as text and as --json. */
  const both = (...args: string[]) => [nexus(args), nexus([...args, "--json"])];

  const captures: Capture[] = [
    ...[
      "/v1/health", "/v1/projects", "/v1/nodes", "/v1/images", "/v1/images/current", "/v1/release", "/v1/deployer/release",
      "/v1/threads", "/v1/threads?deleted=false", "/v1/threads?project=storefront", "/v1/queued", "/v1/items", "/v1/items?project=nexus",
      "/v1/events", "/v1/events?project=field-notes", "/v1/events?kind=thread.started", "/v1/checks", "/v1/checks/changes", "/v1/doctor",
      "/v1/usage", "/v1/usage?since=7d", "/v1/usage?since=30d&by=model&by=day", "/v1/usage?since=today&project=nexus", "/v1/usage?since=2027-01-10", "/v1/usage/backfill",
      "/v1/threads/th-000000000000", "/v1/nosuch",
    ].map(api),
    ...threads.flatMap(([, thread]) => [api(`/v1/threads/${thread.id}`), api(`/v1/threads/${thread.id}/conversation`), api(`/v1/events?thread=${thread.id}`)]),
    ...queued.map((q) => api(`/v1/queued/${q.id}`)),
    ...items.map((i) => api(`/v1/items/${i.id}`)),
    ...nodes.flatMap((n) => [
      api(`/v1/nodes/${n}/health`),
      api(`/v1/nodes/${n}/metrics?from=${Date.now() - hour}`), api(`/v1/nodes/${n}/metrics?from=${Date.now() - day}`),
      api(`/v1/nodes/${n}/metrics?from=${Date.now() - 31 * day}&to=${Date.now() - 30 * day}`), api(`/v1/nodes/${n}/metrics`),
    ]),

    ...[
      "/", "/threads/new", "/threads/new?project=storefront", "/projects/new", "/pipeline", "/cluster", "/health",
      "/usage", "/usage?period=today", "/usage?period=30d", "/usage?period=all", "/usage?project=nexus", "/threads/th-000000000000", "/nodes/nosuch",
    ].map(page),
    ...threads.map(([, thread]) => page(`/threads/${thread.id}`)),
    // A peek of each kind of thread, since the rest of the home page is the same under each.
    ...threads.filter(([key]) => peeked.includes(key)).map(([, thread]) => page(`/?peek=${thread.id}`)),
    ...queued.flatMap((q) => [page(`/threads/${q.id}`), page(`/?peek=${q.id}`)]),
    ...items.map((i) => page(`/?peek=${i.id}`)),
    ...nodes.map((n) => page(`/nodes/${n}`)),

    nexus(["--help"]), nexus(["--version"]), nexus(["nosuch"]),
    ...both("projects"), ...both("nodes"), ...both("release"), ...both("doctor"), ...both("items"), ...both("items", "--all"),
    ...both("threads"), ...both("threads", "--all"), ...both("threads", "--queued"), ...both("threads", "--project", "storefront"),
    ...both("image", "list"), ...both("image", "current"), ...both("events", "--project", "field-notes"),
    ...both("usage"), ...both("usage", "--since", "all"), ...both("usage", "--by", "model"), ...both("usage", "--by", "day"), ...both("usage", "--by", "role"),
    ...both("usage", "backfill", "--dry-run"),
    ...projects.flatMap((p) => both("project", "show", p)),
    ...nodes.flatMap((n) => both("node", n)),
    ...items.flatMap((i) => both("item", "show", i.id)),
    ...threads.flatMap(([, thread]) => [...both("show", thread.id), ...both("conversation", thread.id)]),
    ...both("show", "th-000000000000"),
  ];
  // A read of the pylon's checkout records a human's visit to its thread, so these run after the reads above.
  const visits: Capture[] = [
    ...[
      `/v1/threads/${checked.id}/files`, `/v1/threads/${checked.id}/files?path=src`, `/v1/threads/${checked.id}/files/content?path=src/backoff.ts`,
      `/v1/threads/${checked.id}/changes`, `/v1/threads/${checked.id}/changes?base=head`, `/v1/threads/${checked.id}/changes?base=turn`,
      `/v1/threads/${checked.id}/diff`, `/v1/threads/${checked.id}/diff?base=head&path=README.md`,
    ].map(api),
    ...both("ports", checked.id), ...both("files", checked.id), ...both("files", checked.id, "src"),
    ...both("changes", checked.id), ...both("changes", checked.id, "--uncommitted"), ...both("changes", checked.id, "--turn"),
    ...both("diff", checked.id), ...both("diff", checked.id, "README.md"),
  ];

  const read = (c: Capture) => within(c).then(normal);
  const texts = [...await pool(captures, 8, read), ...await pool(visits, 8, read)];
  const all = [...captures, ...visits];
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
  const changed: string[] = [];
  for (const [file, text] of wanted) {
    const golden = await readFile(join(root, file), "utf8").catch(() => null);
    if (golden !== text) changed.push(golden === null ? `${file} (new)` : file);
  }
  for (const file of kept) if (!wanted.has(file)) changed.push(`${file} (no longer captured)`);
  assert.deepEqual(changed, [], "these captures differ from src/golden/. Run NEXUS_GOLDEN_UPDATE=1 node --test src/golden.test.ts and read the diff");
});

/** A capture's text, or a failure that names it if it has not answered in 60 s, as a hang would. A CLI it ran is killed. */
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
