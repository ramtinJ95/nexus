/**
 * The commands on threads: listing, showing and starting them, their ports, previews, files and sessions, sending to
 * their agents, and their lifecycle.
 */
import { randomUUID } from "node:crypto";
import type { Preview } from "../../control/thread-store.ts";
import { threadRoutes as routes } from "../../contract/threads.ts";
import { pylonRoutes, type ChangesBase } from "../../contract/pylon.ts";
import { attachTerminal, processTty } from "../attach.ts";
import { CliError } from "../transport.ts";
import { type Values, type Api, type Command, str, request, int, workerOptions, briefOf, table, waitMs, waitPollMs, pollUntil, whenRunning } from "../kit.ts";
import { detailText, portsText, listingText, changesText, queuedRow, queuedText, threadRow } from "../thread-text.ts";

function portArg(given: string): number {
  const port = Number(given);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError("invalid", `the port must be a whole number from 1 to 65535, got ${given}`);
  return port;
}

const baseOf = (v: Values): ChangesBase => {
  if (v.uncommitted === true && v.turn === true) throw new CliError("invalid", "--turn and --uncommitted cannot be used together");
  return v.turn === true ? "turn" : v.uncommitted === true ? "head" : "start";
};

/** Polls the thread until its node reports the port listening and its preview published and warmed. */
async function served(api: Api, id: string, port: number): Promise<Preview> {
  let preview: Preview | null | undefined;
  return pollUntil({
    deadlineMs: waitMs, everyMs: waitPollMs,
    timedOut: () => {
      const why = preview && preview.failed !== null ? `, because ${preview.failed}` : "";
      return new CliError("failed", `port ${port} of ${id} was not served within ${waitMs / 1000} s${why}. \`nexus ports ${id}\` shows whether it listens and whether its preview is published`);
    },
  }, async () => {
    const d = await request(api, routes.show, { thread: id });
    preview = d.ports?.find((l) => l.port === port)?.preview;
    return preview?.ready === true ? preview : undefined;
  });
}

/** "A", "A and B", or "A, B and C". */
const listed = (names: readonly string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** A thread action whose route answers 204. Its JSON is null. */
const action = (done: string, call: (api: Api, thread: string) => Promise<null>): Command => ({
  args: [1, 1],
  async run(api, [id]) {
    await call(api, id!);
    return { json: null, text: `${done} ${id}.` };
  },
});

/** A thread action whose route answers the thread, or the queued thread when it has not started. */
const statusChange = (route: typeof routes.archive | typeof routes.unarchive | typeof routes.delete, done: string, queued: string): Command => ({
  args: [1, 1],
  async run(api, [id]) {
    const t = await request(api, route, { thread: id! });
    return { json: t, text: `${done} ${t.id}.${"waits" in t ? ` ${queued}` : ""}` };
  },
});

export const threadsCommands: Readonly<Record<string, Command>> = {
  threads: {
    args: [0, 0],
    options: { project: { type: "string" }, all: { type: "boolean" }, queued: { type: "boolean" } },
    async run(api, _, v) {
      const project = str(v, "project");
      const queuing = request(api, routes.queued, { query: { project, ...v.all === true ? {} : { status: "queued" } } });
      if (v.queued === true) {
        const queued = await queuing;
        return { json: queued, text: queued.length === 0 ? "No queued threads." : table(queued.map(queuedRow)) };
      }
      const [queued, shown] = await Promise.all([queuing, request(api, routes.list, { query: { project, ...v.all === true ? {} : { deleted: false } } })]);
      const rows = [...shown.map(threadRow), ...queued.map(queuedRow)];
      return { json: shown, text: rows.length === 0 ? "No threads." : table(rows) };
    },
  },
  show: {
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
  },
  ports: {
    args: [1, 1],
    async run(api, [id]) {
      const d = await request(api, routes.show, { thread: id! });
      return { json: d.ports, text: portsText(d.ports, id!) };
    },
  },
  preview: {
    args: [2, 2],
    options: { wait: { type: "boolean" } },
    async run(api, [id, given], v) {
      const port = portArg(given!);
      const linked = await request(api, pylonRoutes.preview, { thread: id!, body: { port } });
      const preview = v.wait === true ? await served(api, id!, port) : linked;
      return { json: preview, text: preview.failed !== null ? `${preview.url} (not ready: ${preview.failed})` : preview.ready ? preview.url : `${preview.url} (not served yet. \`--wait\` waits until it is)` };
    },
  },
  unpreview: {
    args: [2, 2],
    async run(api, [id, given]) {
      const port = portArg(given!);
      await whenRunning(api, id!, () => request(api, pylonRoutes.unpreview, { thread: id!, port: String(port) }), `port ${port} is still published`);
      return { json: null, text: `Unpublished port ${port} of ${id}.` };
    },
  },
  files: {
    args: [1, 2],
    async run(api, [id, path = ""]) {
      const l = await whenRunning(api, id!, () => request(api, pylonRoutes.files, { thread: id!, query: { path } }), "nothing was listed");
      return { json: l, text: listingText(l) };
    },
  },
  changes: {
    args: [1, 1],
    options: { uncommitted: { type: "boolean" }, turn: { type: "boolean" } },
    async run(api, [id], v) {
      const c = await whenRunning(api, id!, () => request(api, pylonRoutes.changes, { thread: id!, query: { base: baseOf(v) } }), "no changes were read");
      return { json: c, text: changesText(c) };
    },
  },
  diff: {
    args: [1, Infinity],
    options: { uncommitted: { type: "boolean" }, turn: { type: "boolean" } },
    async run(api, [id, ...paths], v) {
      const query = { base: baseOf(v), paths };
      const d = await whenRunning(api, id!, () => request(api, pylonRoutes.diff, { thread: id!, query }), "no diff was read");
      const text = d.diff === "" ? "No changes." : d.diff.replace(/\n$/, "");
      return { json: d, text: d.truncated ? `${text}\n[The diff stops here, at its 4 MiB limit. Name paths to see the rest.]` : text };
    },
  },
  "session open": {
    args: [1, 1],
    options: { harness: { type: "string" }, title: { type: "string" } },
    async run(api, [id], v) {
      const body = Object.fromEntries((["harness", "title"] as const).flatMap((key) => v[key] === undefined ? [] : [[key, v[key]]]));
      // The API answers once the agent is ready or waits for its human, which can take a minute.
      const opened = await whenRunning(api, id!, () => request(api, pylonRoutes.openSession, { thread: id!, body }), "no session was opened");
      return { json: opened, text: `Opened ${opened.harness} session ${JSON.stringify(opened.title)} in pane ${opened.herdrPane} of ${id}. \`nexus attach ${id}\` attaches to it.` };
    },
  },
  // Not tried again on a 409: a paused session comes back with its pylon's wake, and a pane asked for before the wake
  // may name another session after it.
  "session close": {
    args: [2, 2],
    async run(api, [id, session]) {
      await request(api, pylonRoutes.closeSession, { thread: id!, session: session! });
      return { json: null, text: `Closed session ${session} of ${id}.` };
    },
  },
  attach: {
    args: [1, 1],
    async run(_api, [id], _values, _follow, local) {
      await attachTerminal(local.connect, id!, processTty());
    },
  },
  start: {
    args: [0, 0],
    options: { ...workerOptions, "request-id": { type: "string" }, plan: { type: "boolean" } },
    async run(api, _, v) {
      if (v.plan === true && (v.claude !== undefined || v.after !== undefined)) throw new CliError("invalid", "--plan starts a Nexus agent thread now, so it takes neither --claude nor --after");
      const { project, title, optional, resources, after } = briefOf(v, "start");
      if (title === undefined) throw new CliError("invalid", "start needs --title, --message or --claude");
      const requestId = str(v, "request-id");
      // One request: the control plane sends the first message once the thread starts, as the person's.
      const body = { project, title, ...optional, ...resources === undefined ? {} : { resources }, ...requestId === undefined ? {} : { requestId }, ...v.plan === true ? { planning: true as const } : {} };
      if (after !== undefined) {
        const q = await request(api, routes.start, { body: { ...body, after } });
        // A repeat of the request ID after the queued thread started answers the thread.
        if (!("after" in q)) return { json: q, text: `Started ${q.id} on ${q.project}: ${q.title}` };
        return { json: q, text: `Queued ${q.id} on ${q.project}: ${q.title}. It starts once ${listed(q.after)} ${q.after.length === 1 ? "has merged its pull request" : "have merged their pull requests"}.` };
      }
      const t = await request(api, routes.start, { body });
      return { json: t, text: `Started ${v.plan === true ? "planning thread " : ""}${t.id} on ${t.project}: ${t.title}${v.message === undefined ? "" : "\nSent the first message."}` };
    },
  },
  "start-queued": {
    args: [1, 1],
    async run(api, [id]) {
      const t = await request(api, routes.startQueued, { thread: id! });
      return { json: t, text: `Started ${t.id} on ${t.project}: ${t.title}` };
    },
  },
  send: {
    args: [2, Infinity],
    options: { steer: { type: "boolean" }, "request-id": { type: "string" } },
    async run(api, [id, ...words], v) {
      const steer = v.steer === true;
      // The API treats a resend with the same request ID as the same message, so a caller that retries passes one.
      const requestId = str(v, "request-id") ?? `msg:${randomUUID()}`;
      // A Claude worker's message is typed in its pylon, so its send waits for a paused pylon to wake.
      const claude = (await request(api, routes.show, { thread: id! })).claudeWorker !== undefined;
      const body = { text: words.join(" "), requestId, mode: steer ? "steer" as const : "followUp" as const };
      const message = () => request(api, routes.message, { thread: id!, body });
      const reply = claude ? await whenRunning(api, id!, message, "the message was not sent") : await message();
      if ("claude" in reply) {
        const resumed = reply.claude.resumed ? " Its session was resumed to take it." : "";
        return { json: reply, text: reply.claude.outcome === "queued" ? `Queued for Claude in ${id}, which takes it at its next step.${resumed}` : `Sent to Claude in ${id}.${resumed}` };
      }
      return { json: reply, text: steer ? `Sent to ${id}, to join the current run after its tool round.` : `Sent to ${id}.` };
    },
  },
  seen: {
    args: [1, 1],
    options: { unread: { type: "boolean" }, "last-reply-at": { type: "string" } },
    async run(api, [id], v) {
      const shown = str(v, "last-reply-at");
      if (shown !== undefined && v.unread) throw new CliError("invalid", "--last-reply-at marks a reply seen, so it cannot go with --unread");
      await request(api, v.unread ? routes.unseen : routes.seen, { thread: id!, body: shown === undefined ? {} : { lastReplyAt: int(shown, "--last-reply-at", 0) } });
      return { json: null, text: `Marked ${id} ${v.unread ? "unread" : "seen"}.` };
    },
  },
  abort: action("Aborted the run of", (api, thread) => request(api, routes.abort, { thread })),
  retry: action("Retried the parked tasks of", (api, thread) => request(api, routes.retry, { thread })),
  "retry-pylon": action("Retried the pylon of", (api, thread) => request(api, routes.retryPylon, { thread })),
  wake: action("Recorded activity on", (api, thread) => request(api, routes.activity, { thread, body: { kind: "human" } })),
  archive: statusChange(routes.archive, "Archived", "Its queued start is cancelled."),
  unarchive: statusChange(routes.unarchive, "Unarchived", "It is queued again."),
  delete: statusChange(routes.delete, "Deleted", "It will never start."),
};
