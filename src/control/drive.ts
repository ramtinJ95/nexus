/**
 * The control plane's side of the drive tools (src/harness/drive-tools.ts). Every rule is here, read from the calling
 * thread's record, so its model cannot widen it: only a thread a person started with the drive tools may call them, a
 * thread it starts is its child, threads.ts caps its live children, and a child never has the tools. A start goes through
 * the same retry-safe path as POST /v1/threads, under the call's request ID.
 */
import type { Drive } from "../harness/drive-tools.ts";
import type { HarnessHost } from "../harness/host.ts";
import { HttpError } from "./http-error.ts";
import type { Inbox } from "./inbox.ts";
import type { Registry, Thread, ThreadId } from "./registry.ts";
import type { threadStarts } from "./starts.ts";
import { maxWatches, sinceOf } from "./watches.ts";

/** How much of a thread's conversation nexus_read returns. */
const tailMessages = 10;
const tailChars = 2_000;

type Said = { from: string; text: string };

export function driveCalls(options: { registry: Registry; start: ReturnType<typeof threadStarts>; inbox: Inbox; harness: Pick<HarnessHost, "watch">; watches: { poll(): Promise<void> }; now?: () => number }): Drive {
  const { registry, start, inbox, harness, watches, now = Date.now } = options;

  function driver(caller: string): Thread {
    const t = registry.thread(caller as ThreadId);
    if (t?.drive !== true) throw new HttpError(403, `thread ${caller} has no drive tools`);
    if (t.status === "archived" || t.status === "deleted") throw new HttpError(409, `thread ${t.id} is ${t.status}, so its tools act on nothing`);
    return t;
  }

  function other(from: Thread, id: string, verb: string): Thread {
    const t = registry.thread(id as ThreadId);
    if (t === undefined) throw new HttpError(404, `no thread ${id}`);
    if (t.id === from.id) throw new HttpError(400, `a thread cannot ${verb} itself`);
    return t;
  }

  const cut = (text: string) => text.length > tailChars ? `${text.slice(0, tailChars)}…` : text;

  async function said(t: Thread): Promise<Said[]> {
    switch (registry.agent(t).kind) {
      case "none": return [];
      case "claude": return registry.claudeEntries(t.id).flatMap((e) => e.kind === "prompt" ? [{ from: e.from, text: e.text }] : e.kind === "reply" ? [{ from: "agent", text: e.text }] : []);
      case "harness": {
        if (t.status === "deleted") return [];
        const watch = await harness.watch(t.id);
        try {
          return watch.value.entries.flatMap((entry) => (entry.model ?? []).flatMap((m): Said[] => {
            if (m.role === "user") return [{ from: entry.kind.startsWith("nexus.") ? entry.kind.slice(6) : "person", text: typeof m.content === "string" ? m.content : m.content.flatMap((c) => c.type === "text" ? [c.text] : []).join("") }];
            if (m.role === "assistant") return [{ from: "agent", text: m.content.flatMap((c) => c.type === "text" ? [c.text] : []).join("") }];
            return [];
          })).filter((s) => s.text !== "");
        } finally {
          await watch.stop();
        }
      }
    }
  }

  return {
    async read(caller, id) {
      driver(caller);
      const t = registry.thread(id as ThreadId);
      if (t === undefined) throw new HttpError(404, `no thread ${id}`);
      const review = registry.review(t.id);
      return {
        id: t.id, title: t.title, project: t.project, status: t.status, attention: registry.attention(t.id), agent: registry.agent(t).kind, working: t.working,
        ...t.parent === undefined ? {} : { parent: t.parent }, ...t.drive === true ? { drive: true } : {},
        pylonFailed: registry.pylon(t.pylonId)?.failed ?? null,
        pullRequests: (registry.prWatch(t.id)?.links ?? []).filter((l) => l.pr.url !== "").map(({ pr }) => ({ url: pr.url, title: pr.title, state: pr.state, checks: pr.checks })),
        review: review === null ? null : { pr: review.pr.url, phase: review.phase.kind, rounds: review.rounds.length },
        openQuestions: registry.questions(t.id).filter((q) => q.answer === null).map((q) => ({ text: q.text, options: q.options })),
        children: registry.children(t.id).map((c) => ({ id: c.id, title: c.title, status: c.status })),
        conversation: (await said(t)).slice(-tailMessages).map((s) => ({ ...s, text: cut(s.text) })),
      };
    },
    async start(caller, { project, title, brief, agent, model, branch }, requestId) {
      const parent = driver(caller);
      if (agent === "nexus" && model !== undefined) throw new HttpError(400, "model is a Claude worker's, and a Nexus agent thread runs the control plane's model");
      const from = `From thread ${parent.id} "${parent.title}", which started this thread with nexus_start:\n\n${brief}`;
      // The person who started the parent is who the child acts for, so its usage and nudges count it as their builder.
      const t = await start({
        project, title, parent: parent.id, requestId, ...branch === undefined ? {} : { branch },
        ...agent === "claude" ? { claude: from, ...model === undefined ? {} : { model } } : { message: from },
      }, parent.startedBy) as Thread;
      return { id: t.id, title: t.title, project: t.project, status: t.status, agent };
    },
    async send(caller, id, text, requestId) {
      const from = driver(caller);
      const t = other(from, id, "message");
      if (t.status === "archived" || t.status === "deleted") throw new HttpError(409, `thread ${t.id} is ${t.status}, so its agent takes no messages`);
      if (registry.agent(t).kind === "none") throw new HttpError(409, `thread ${t.id} has no agent to take a message`);
      const outcome = await inbox(t, { id: requestId, text: `[Nexus thread ${from.id} "${from.title}" — sent with nexus_send, not by the person]\n${text}`, sender: "thread" });
      return outcome === "delivered" ? { thread: t.id, delivered: true } : { thread: t.id, delivered: false, why: "its pylon is waking, and nothing was typed yet. Send it again in a minute" };
    },
    async wait(caller, id, until, watchId) {
      const from = driver(caller);
      const t = other(from, id, "watch");
      if (registry.watch(watchId) === null && registry.pendingWatches(from.id).length >= maxWatches) {
        throw new HttpError(409, `thread ${from.id} already waits on ${maxWatches} watches, the most a thread may. Each ends once Nexus sends its message`);
      }
      const watch = registry.addWatch({ id: watchId, waiter: from.id, thread: t.id, until, since: sinceOf(registry, t), createdAt: now(), delivered: null });
      void watches.poll();
      return { watch: watch.id, thread: t.id, until, delivered: watch.delivered !== null, note: "Nexus sends you a message when it happens. End your turn now rather than polling" };
    },
  };
}
