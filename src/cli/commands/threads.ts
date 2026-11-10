import { randomUUID } from "node:crypto";
import { sessionHarnessSchema } from "../../protocol/agent-kinds.ts";
import { threadRoutes as routes, type Preview } from "../../contract/threads.ts";
import { pylonRoutes, type ChangesBase } from "../../contract/pylon.ts";
import { projectOf, threadOf } from "../refs.ts";
import { attachTerminal, processTty } from "../attach.ts";
import { execLine } from "../exec.ts";
import { CliError, UsageError } from "../transport.ts";
import { startRules } from "../../contract/threads-parse.ts";
import { type Values, type Api, type Command, type Io, type Result, str, request, fileOf, int, briefOptions, briefOf, textFrom, colourOf, waitMs, waitPollMs, pollUntil, whenRunning } from "../kit.ts";
import { thenWatch, watchOf, watchOptions } from "./watch.ts";
import { detailText, portsText, listingText, changesText, queuedTable, queuedText, threadsText } from "../thread-text.ts";
import { needsPerson } from "../../contract/attention.ts";

function portArg(given: string): number {
  const port = Number(given);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`the port must be a whole number from 1 to 65535, got ${given}`);
  return port;
}

const baseOf = (v: Values): ChangesBase => {
  if (v.uncommitted === true && v.turn === true) throw new UsageError("--turn and --uncommitted cannot be used together");
  return v.turn === true ? "turn" : v.uncommitted === true ? "head" : "start";
};

/** `published` is what the publish answered, so a terminal sees the preview before the first poll answers. */
async function served(api: Api, io: Io, id: string, port: number, published: Preview): Promise<Preview> {
  let preview: Preview | null = published;
  return pollUntil({
    deadlineMs: waitMs, everyMs: waitPollMs,
    timedOut: () => {
      const why = preview && preview.failed !== null ? `, because ${preview.failed}` : "";
      return new CliError("failed", `port ${port} of ${id} was not served within ${waitMs / 1000} s${why}. \`nexus ports ${id}\` shows whether it listens and whether its preview is published`);
    },
    shown: {
      to: io.stderr,
      state: () => preview === null ? `Port ${port} of ${id} has no preview yet`
        : preview.ready ? undefined
        : `${preview.url} is published, and not served yet${preview.failed === null ? "" : `, because ${preview.failed}`}`,
      stopped: () => `Stopped waiting. The preview stays published, and \`nexus ports ${id}\` shows when it is served`,
    },
  }, async () => {
    const d = await request(api, routes.show, { thread: id });
    preview = d.ports?.find((l) => l.port === port)?.preview ?? null;
    return preview?.ready === true ? preview : undefined;
  });
}

const listed = (names: readonly string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const actionHelp = ["  nexus abort|retry|retry-pylon|wake <thread>"];
const action = (done: string, call: (api: Api, thread: string) => Promise<null>): Command => ({
  help: actionHelp,
  args: [1, 1],
  thread: true,
  async run(api, [id]) {
    await call(api, id!);
    return { json: null, text: `${done} ${id}.` };
  },
});

/** One outcome of a command given several threads, in the order given, as `--json` prints it. */
type Outcome = { given: string; reply: unknown } | { given: string; error: string; kind: CliError["kind"]; status: number | null; code: string | null };

/**
 * One thread runs as it always has, and its failure is the command's. Several run one after another, so one that
 * fails stops none of the rest: each prints its line, and the first failure's kind is the exit code.
 */
async function eachThread(api: Api, given: readonly string[], one: (thread: string) => Promise<Result>): Promise<Result> {
  if (given.length === 1) return await one(await threadOf(api, given[0]!));
  const outcomes: Outcome[] = [];
  const lines: string[] = [];
  for (const g of given) {
    try {
      const done = await one(await threadOf(api, g));
      outcomes.push({ given: g, reply: done.json });
      lines.push(done.text);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      outcomes.push({ given: g, error: err.message, kind: err.kind, status: err.status, code: err.code });
      lines.push(`${g}: ${err.message}`);
    }
  }
  const failed = outcomes.find((o) => "error" in o);
  return { json: outcomes, text: lines.join("\n"), ...failed === undefined ? {} : { exit: failed.kind } };
}

const statusHelp = ["  nexus archive|unarchive|delete <thread...>"];
const statusChange = (route: typeof routes.archive | typeof routes.unarchive | typeof routes.delete, done: string, queued: string): Command => ({
  help: statusHelp,
  args: [1, Infinity],
  thread: "each",
  run: (api, given) => eachThread(api, given, async (id) => {
    const t = await request(api, route, { thread: id });
    return { json: t, text: `${done} ${t.id}.${"waits" in t ? ` ${queued}` : ""}` };
  }),
});

const show: Command = {
  help: [
    "  nexus show <thread>                          a thread with its pylon, sessions, previews and outputs",
    "    thread show <thread> is the same",
  ],
  thread: true,
  args: [1, 1],
  async run(api, [id]) {
    let d;
    try {
      d = await request(api, routes.show, { thread: id! });
    } catch (err) {
      if (!(err instanceof CliError) || err.code !== "queued") throw err;
      const q = await request(api, routes.queuedThread, { thread: id! });
      return { json: q, text: queuedText(q) };
    }
    return { json: d, text: detailText(d) };
  },
};

export const threadsCommands: Readonly<Record<string, Command>> = {
  threads: {
    help: [
      "  nexus threads [--project P] [--all] [--open] [--active] [--needs-me] [--limit N] [--queued]",
      "    threads, then queued ones; deleted ones and cancelled queued ones only with --all, no archived ones with --open, and --queued lists only queued ones",
      "    --active lists only active threads and --needs-me only those whose attention waits on you, with no queued ones; --limit N the first N",
    ],
    args: [0, 0],
    options: { project: { type: "string" }, all: { type: "boolean" }, open: { type: "boolean" }, queued: { type: "boolean" }, active: { type: "boolean" }, "needs-me": { type: "boolean" }, limit: { type: "string" } },
    async run(api, _, v, _follow, { io }) {
      const project = str(v, "project");
      const limit = int(str(v, "limit"), "--limit", Infinity);
      if (limit === 0) throw new UsageError("--limit takes 1 or more");
      const onlyThreads = v.active === true || v["needs-me"] === true;
      if (v.queued === true && onlyThreads) throw new UsageError("--queued lists threads that have not started, so it cannot go with --active or --needs-me");
      const colour = colourOf(io);
      const queuing = onlyThreads ? Promise.resolve([]) : request(api, routes.queued, { query: { project, ...v.all === true ? {} : { status: "queued" } } });
      if (v.queued === true) {
        const queued = (await queuing).slice(0, limit);
        return { json: queued, text: queued.length === 0 ? "No queued threads." : queuedTable(queued, colour) };
      }
      const listing = request(api, routes.list, { query: { project, ...v.open === true ? { deleted: false, status: "open" } : v.all === true ? {} : { deleted: false } } });
      // A control plane older than 0.77.0 ignores status=open and answers every thread but the deleted ones.
      const [queued, listed] = await Promise.all([queuing, listing]);
      const shown = listed.filter((r) => (v.open !== true || r.status === "active" || r.status === "idle") && (v.active !== true || r.status === "active") && (v["needs-me"] !== true || needsPerson(r.attention)));
      const threads = shown.slice(0, limit);
      return { json: threads, text: threadsText(threads, queued.slice(0, limit - threads.length), colour) };
    },
  },
  show,
  "thread show": show,
  ports: {
    help: ["  nexus ports <thread>                         the TCP ports the pylon listens on, and each one's preview"],
    thread: true,
    args: [1, 1],
    async run(api, [id]) {
      const d = await request(api, routes.show, { thread: id! });
      return { json: d.ports, text: portsText(d.ports, id!) };
    },
  },
  preview: {
    help: ["  nexus preview <thread> <port> [--wait]       publish a port as a preview, and print its URL"],
    thread: true,
    args: [2, 2],
    options: { wait: { type: "boolean" } },
    async run(api, [id, given], v, _follow, { io }) {
      const port = portArg(given!);
      const linked = await request(api, pylonRoutes.preview, { thread: id!, body: { port } });
      const preview = v.wait === true ? await served(api, io, id!, port, linked) : linked;
      return { json: preview, text: preview.failed !== null ? `${preview.url} (not ready: ${preview.failed})` : preview.ready ? preview.url : `${preview.url} (not served yet. \`--wait\` waits until it is)` };
    },
  },
  unpreview: {
    help: ["  nexus unpreview <thread> <port>              stop publishing a port that preview published"],
    thread: true,
    args: [2, 2],
    async run(api, [id, given], _v, _follow, { io }) {
      const port = portArg(given!);
      await whenRunning(api, io, id!, () => request(api, pylonRoutes.unpreview, { thread: id!, port: String(port) }), `port ${port} is still published`);
      return { json: null, text: `Unpublished port ${port} of ${id}.` };
    },
  },
  files: {
    help: ["  nexus files <thread> [path]                  a directory of the pylon's checkout"],
    thread: true,
    args: [1, 2],
    async run(api, [id, path = ""], _v, _follow, { io }) {
      const l = await whenRunning(api, io, id!, () => request(api, pylonRoutes.files, { thread: id!, query: { path } }), "nothing was listed");
      return { json: l, text: listingText(l) };
    },
  },
  cat: {
    help: ["  nexus cat <thread> <path>                    a file of the pylon's checkout, written to stdout as its bytes"],
    thread: true,
    args: [2, 2],
    async run(api, [id, path], v, _follow, { io }) {
      if (v.json === true) throw new UsageError("cat writes the file's bytes as they are, so it takes no --json. `nexus files <thread> [dir] --json` gives a file's size");
      const bytes = await whenRunning(api, io, id!, () => fileOf(api, pylonRoutes.file, { thread: id!, query: { path: path! } }), "nothing was read");
      io.stdout.write(bytes);
    },
  },
  changes: {
    help: ["  nexus changes <thread> [--uncommitted | --turn]       the files changed since boot, HEAD, or the latest turn"],
    thread: true,
    args: [1, 1],
    options: { uncommitted: { type: "boolean" }, turn: { type: "boolean" } },
    async run(api, [id], v, _follow, { io }) {
      const c = await whenRunning(api, io, id!, () => request(api, pylonRoutes.changes, { thread: id!, query: { base: baseOf(v) } }), "no changes were read");
      return { json: c, text: changesText(c) };
    },
  },
  diff: {
    help: ["  nexus diff <thread> [path...] [--uncommitted | --turn]"],
    thread: true,
    args: [1, Infinity],
    options: { uncommitted: { type: "boolean" }, turn: { type: "boolean" } },
    async run(api, [id, ...paths], v, _follow, { io }) {
      const query = { base: baseOf(v), paths };
      const d = await whenRunning(api, io, id!, () => request(api, pylonRoutes.diff, { thread: id!, query }), "no diff was read");
      const text = d.diff === "" ? "No changes." : d.diff.replace(/\n$/, "");
      return { json: d, text: d.truncated ? `${text}\n[The diff stops here, at its 4 MiB limit. Name paths to see the rest.]` : text };
    },
  },
  "session open": {
    help: [`  nexus session open <thread> [--harness ${sessionHarnessSchema.options.join("|")}] [--title T]`],
    thread: true,
    args: [1, 1],
    options: { harness: { type: "string" }, title: { type: "string" } },
    async run(api, [id], v, _follow, { io }) {
      const body = Object.fromEntries((["harness", "title"] as const).flatMap((key) => v[key] === undefined ? [] : [[key, v[key]]]));
      // The API answers once the agent is ready or waits for its human, which can take a minute.
      const opened = await whenRunning(api, io, id!, () => request(api, pylonRoutes.openSession, { thread: id!, body }), "no session was opened");
      return { json: opened, text: `Opened ${opened.harness} session ${JSON.stringify(opened.title)} in pane ${opened.herdrPane} of ${id}. \`nexus attach ${id}\` attaches to it.` };
    },
  },
  // Not tried again on a 409: a paused session comes back with its pylon's wake, and a pane asked for before the wake
  // may name another session after it.
  "session close": {
    help: ["  nexus session close <thread> <pane|id>       a session in no pane by its ID, which `nexus show` gives"],
    thread: true,
    args: [2, 2],
    async run(api, [id, session]) {
      await request(api, pylonRoutes.closeSession, { thread: id!, session: session! });
      return { json: null, text: `Closed session ${session} of ${id}.` };
    },
  },
  attach: {
    help: ["  nexus attach <thread>                        this terminal on the pylon's Herdr sessions, through the control plane"],
    thread: true,
    args: [1, 1],
    async run(_api, [id], _values, _follow, local) {
      await attachTerminal(local.connect, id!, processTty());
    },
  },
  exec: {
    help: ["  nexus exec <thread> <line>                   runs a shell line in the running pylon with stdin and stdout piped, as ssh does"],
    thread: true,
    args: [2, 2],
    async run(_api, [id, line], _values, _follow, local) {
      return await execLine(local.connect, id!, line!);
    },
  },
  start: {
    help: [
      "  nexus start [--project P] [--title T] [--message M | --claude PROMPT [--model ID]] [--node N|auto] [--branch B] [--commit C]",
      "              [--cpus n] [--memory GiB] [--disk GiB] [--after THREAD[,THREAD...]] [--request-id ID] [--plan] [--watch [--interval MS]]",
      "    --message-file PATH|- and --claude-file PATH|- read the message or prompt from a file or stdin",
      "    --after queues it to start once each of those threads' pull requests has merged",
      "    --plan makes it a planning thread, whose proposed items become questions you accept or reject",
      "    --request-id makes a repeat of the start answer the thread the first made",
      "    --watch then follows the run until it replies, as watch --until-idle does",
    ],
    args: [0, 0],
    options: { ...briefOptions, ...watchOptions, "request-id": { type: "string" }, plan: { type: "boolean" } },
    async run(api, _, v, follow, { io }) {
      const interval = watchOf(v);
      if (v.watch === true && ["message", "message-file", "claude", "claude-file"].every((flag) => v[flag] === undefined)) throw new UsageError("--watch waits for the reply to the first message, so it needs --message, --claude or their -file flags");
      if (v.watch === true && v.after !== undefined) throw new UsageError("--watch cannot go with --after, since a queued thread has no run yet");
      // One request: the control plane sends the first message once the thread starts, as the person's.
      const body = await briefOf(v, await projectOf(api, v, "start"), startRules, io.stdin);
      if (body.after !== undefined) {
        const q = await request(api, routes.start, { body });
        // A repeat of the request ID after the queued thread started answers the thread.
        if (!("after" in q)) return { json: q, text: `Started ${q.id} on ${q.project}: ${q.title}` };
        return { json: q, text: `Queued ${q.id} on ${q.project}: ${q.title}. It starts once ${listed(q.after)} ${q.after.length === 1 ? "has merged its pull request" : "have merged their pull requests"}.` };
      }
      const t = await request(api, routes.start, { body });
      const started = `Started ${v.plan === true ? "planning thread " : ""}${t.id} on ${t.project}: ${t.title}${body.message == null ? "" : "\nSent the first message."}`;
      return await thenWatch(api, follow, io, v, interval, t.id, {
        json: t, text: v.watch === true ? started : `${started}\n\`nexus watch ${t.id}\` follows it.`,
      }, { since: { lastReplyAt: null, questions: [] }, from: null });
    },
  },
  "start-queued": {
    help: ["  nexus start-queued <thread>                  start a queued thread now, without waiting for the threads it is queued after"],
    thread: true,
    args: [1, 1],
    async run(api, [id]) {
      const t = await request(api, routes.startQueued, { thread: id! });
      return { json: t, text: `Started ${t.id} on ${t.project}: ${t.title}` };
    },
  },
  send: {
    help: [
      "  nexus send <thread> (<text...> | - | --file PATH) [--steer] [--request-id ID] [--watch [--interval MS]]",
      "    a message to the agent, or typed into the Claude worker's session, which waits for a paused pylon to wake",
      "    - reads it from stdin and --file from a file. Text after -- is never read as flags, such as nexus send <thread> -- -x",
      "    --watch then follows the run until it replies, as watch --until-idle does",
    ],
    thread: true,
    args: [1, Infinity],
    options: { ...watchOptions, steer: { type: "boolean" }, "request-id": { type: "string" }, file: { type: "string" } },
    dashHint: "To send text that starts with a dash, put -- before it, or pass it on stdin with - or from a file with --file PATH",
    async run(api, [id, ...words], v, follow, { io }) {
      const interval = watchOf(v);
      const file = str(v, "file");
      if (file !== undefined && words.length > 0) throw new UsageError("send takes its text as words, -, or --file, not both words and --file");
      if (file === undefined && words.length === 0) throw new UsageError("send needs the message: words, - to read stdin, or --file PATH");
      const text = file !== undefined ? await textFrom(file, "--file", io.stdin) : words.length === 1 && words[0] === "-" ? await textFrom("-", "send -", io.stdin) : words.join(" ");
      const steer = v.steer === true;
      // The API treats a resend with the same request ID as the same message, so a caller that retries passes one.
      const requestId = str(v, "request-id") ?? `msg:${randomUUID()}`;
      // A Claude worker's message is typed in its pylon, so its send waits for a paused pylon to wake.
      const before = await request(api, routes.show, { thread: id! });
      const claude = before.claudeWorker !== undefined;
      const body = { text, requestId, mode: steer ? "steer" as const : "followUp" as const };
      const message = () => request(api, routes.message, { thread: id!, body });
      const reply = claude ? await whenRunning(api, io, id!, message, "the message was not sent") : await message();
      const resumed = "claude" in reply && reply.claude.resumed ? " Its session was resumed to take it." : "";
      const said = "claude" in reply ? reply.claude.outcome === "queued" ? `Queued for Claude in ${id}, which takes it at its next step.${resumed}` : `Sent to Claude in ${id}.${resumed}`
        : steer ? `Sent to ${id}, to join the current run after its tool round.` : `Sent to ${id}.`;
      return await thenWatch(api, follow, io, v, interval, id!, { json: reply, text: said }, { since: before, from: body.text });
    },
  },
  seen: {
    help: [
      "  nexus seen <thread...> [--unread | --last-reply-at MS]",
      "    mark the latest reply seen, or unread, or only up to the reply at MS, as captured with what the client showed",
    ],
    args: [1, Infinity],
    thread: "each",
    options: { unread: { type: "boolean" }, "last-reply-at": { type: "string" } },
    async run(api, given, v) {
      const shown = str(v, "last-reply-at");
      if (shown !== undefined && v.unread) throw new UsageError("--last-reply-at marks a reply seen, so it cannot go with --unread");
      const body = shown === undefined ? {} : { lastReplyAt: int(shown, "--last-reply-at", 0) };
      return await eachThread(api, given, async (id) => {
        await request(api, v.unread ? routes.unseen : routes.seen, { thread: id, body });
        return { json: null, text: `Marked ${id} ${v.unread ? "unread" : "seen"}.` };
      });
    },
  },
  abort: action("Aborted the run of", (api, thread) => request(api, routes.abort, { thread })),
  retry: action("Retried the parked tasks of", (api, thread) => request(api, routes.retry, { thread })),
  "retry-pylon": action("Retried the pylon of", (api, thread) => request(api, routes.retryPylon, { thread })),
  wake: {
    help: actionHelp,
    args: [1, 1],
    thread: true,
    async run(api, [id], v) {
      await request(api, routes.activity, { thread: id!, body: { kind: "human" } });
      if (v.json === true) return { json: null, text: "" };
      const { thread: t, pylon, desired } = await request(api, routes.show, { thread: id! });
      const text = desired !== "running"
        ? `Recorded your activity on ${id}, but it is ${t.status}, so its pylon stays ${desired}.${t.status === "archived" ? ` \`nexus unarchive ${id}\` wakes it.` : ""}`
        : pylon.actualState === "failed" || pylon.failed !== null ? `Recorded your activity on ${id}, but its pylon failed, and activity does not retry it. \`nexus retry-pylon ${id}\` does.`
        : pylon.actualState === "running" ? `Recorded your activity on ${id}, which keeps its running pylon awake.`
        : `Recorded your activity on ${id}, so Nexus wakes its pylon, which is ${pylon.actualState}.`;
      return { json: null, text };
    },
  },
  archive: statusChange(routes.archive, "Archived", "Its queued start is cancelled."),
  unarchive: statusChange(routes.unarchive, "Unarchived", "It is queued again."),
  delete: statusChange(routes.delete, "Deleted", "It will never start."),
};
