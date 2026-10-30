/**
 * The dashboard: server-rendered HTML pages for the control plane, served behind the API's own checks. A page
 * reads the registry the way the JSON API does, so the sidebar, the thread page and `GET /v1/threads/<id>` agree.
 *
 * Every page is the same console, laid out after Jetline's: threads by project on the left, the page in the middle,
 * and on a thread page an inspector on the right whose tabs show the checkout's changes, the previews and ports, and
 * the pylon with its outputs and sessions. A thread page's middle has tabs too: the conversation, and a diff for
 * each changed file opened from the inspector. Starting a thread and adding a project are dialogs every page carries.
 *
 * Every action goes through the JSON API from `dashboard/client.js`, because the API refuses state changes
 * without a JSON content type and an HTML form cannot send one. The client polls each page and swaps the regions
 * marked `data-live` that changed. A thread page also opens its stream, which sends the conversation region as the
 * run streams: whole when its shape changed, or else only the parts that grow in place, the partial answer and
 * each running tool. A Claude worker thread's conversation is its transcript, shown in the same rows. The changes and
 * the diffs are read by the client from the JSON API, because each read reaches into the pylon and counts as a
 * human's visit, so they are read when asked for rather than with every poll.
 */
import type { NodeName, TailnetNodeId } from "../../ids.ts";
import type { ProjectId } from "../../project.ts";
import type { ThreadRow } from "../wire.ts";
import type { Thread, ThreadId } from "../registry.ts";
import type { AgentView } from "../conversation-view.ts";
import { queuedView, type QueuedThread } from "../queue.ts";
import { periods, type Period } from "../usage.ts";
import { ok, type Page } from "../dashboard/view.ts";
import type { DashboardOptions, Context, Need } from "../dashboard/context.ts";
import { assets } from "../dashboard/assets.ts";
import { notFound } from "../dashboard/shell.ts";
import { home, needsOf } from "../dashboard/home.ts";
import { usagePage } from "../dashboard/usage-page.ts";
import { pipelinePage } from "../dashboard/pipeline-page.ts";
import { nodePage } from "../dashboard/node-page.ts";
import { threadPage, queuedPage } from "../dashboard/thread-page.ts";

/** Returns the page for a GET of `path`, or undefined when the path is not the dashboard's. */
export function dashboard(options: DashboardOptions): (path: string, query: URLSearchParams, caller: TailnetNodeId) => Promise<Page | undefined> {
  const { registry, detail, deploys } = options;

  /** A failed read shows in the conversation, so the rest of the page still says what the pylon is doing. */
  async function transcript(t: Thread): Promise<AgentView | Error | null> {
    if (t.status === "deleted") return null;
    return options.conversation(t).catch((err: unknown) => err as Error);
  }

  const pages: readonly [RegExp, (m: RegExpExecArray, query: URLSearchParams, context: () => Context) => Page | Promise<Page>][] = [
    [/^\/$/, (_, __, context) => ok(home(context(), {}))],
    [/^\/threads\/new$/, (_, query, context) => ok(home(context(), { start: { project: query.get("project") } }))],
    [/^\/projects\/new$/, (_, __, context) => ok(home(context(), { addProject: true }))],
    [/^\/usage$/, (_, query, context) => {
      const period = query.get("period") ?? "";
      return ok(usagePage(context(), Object.hasOwn(periods, period) ? period as Period : "7d", (query.get("project") || null) as ProjectId | null));
    }],
    [/^\/pipeline$/, (_, __, context) => ok(pipelinePage(context()))],
    [/^\/threads\/([^/]+)$/, async (m, query, context) => {
      const thread = registry.thread(m[1]! as ThreadId);
      if (thread === undefined) {
        const queued = registry.queuedThread(m[1]! as ThreadId);
        if (queued !== undefined && queued.status !== "started") return ok(queuedPage(context(), queuedView(registry, queued)));
        return { ...ok(notFound(context(), `No thread ${m[1]!}.`)), status: 404 };
      }
      // The reply known before this read is a safe watermark even if another turn ends during it. A Claude worker's
      // transcript is as of its last read that reached its end, which holds the reply only if it started after the
      // reply was recorded.
      const view = await transcript(thread);
      const repliedAt = view !== null && !(view instanceof Error) && view.kind === "claude" && (view.view.readAt ?? 0) < (thread.lastReplyAt ?? 0) ? null : thread.lastReplyAt;
      // After the read, so the facts are no older than the conversation, and a thread deleted meanwhile shows none.
      const d = detail(registry.thread(thread.id)!);
      return ok(threadPage(context(), d, registry.node(d.pylon.node)!, d.thread.status === "deleted" ? null : view, repliedAt, query.has("streaming")));
    }],
    [/^\/nodes\/([^/]+)$/, async (m, _, context) => {
      const c = context();
      const name = m[1]! as NodeName;
      if (c.registry.node(name) === undefined) return { ...ok(notFound(c, `No node ${name}.`)), status: 404 };
      return ok(nodePage(c, name, await options.nodeHealth(c.caller, name).catch((err: unknown) => err as Error)));
    }],
    [/^\/assets\/([\w.-]+)$/, (m, query, context) => {
      const asset = assets.get(m[1]!);
      if (asset === undefined) return { ...ok(notFound(context(), `No asset ${m[1]!}.`)), status: 404 };
      // Pages link each asset with its hash, and a chunk's name has its hash, so neither URL ever changes and the
      // phone keeps it.
      const cache = asset.version === null || query.get("v") === asset.version ? "public, max-age=31536000, immutable" : "no-cache";
      return { status: 200, headers: { "content-type": asset.type, "cache-control": cache, "x-content-type-options": "nosniff" }, body: asset.body };
    }],
  ];

  return async (path, query, caller) => {
    const context = (): Context => {
      // The sidebar and the home table show the same threads.
      const rows = new Map<ThreadId, ThreadRow>();
      const row = (t: Thread) => rows.get(t.id) ?? rows.set(t.id, options.row(t)).get(t.id)!;
      let needs: readonly Need[] | undefined;
      let threads: readonly Thread[] | undefined;
      // registry.threads() is in the order registry.threads(project) is, so each project's keeps its order.
      let byProject: Map<string, Thread[]> | undefined;
      let queued: Map<string, QueuedThread[]> | undefined;
      const c: Context = {
        registry, row, deploys, now: Date.now(), caller, landRefusal: options.landRefusal(caller),
        answerRefusal: (question) => options.answerRefusal(caller, question),
        threads: () => threads ??= registry.threads(),
        threadsIn: (project) => (byProject ??= Map.groupBy(c.threads(), (t) => t.project)).get(project) ?? [],
        queuedIn: (project) => (queued ??= Map.groupBy(registry.queuedThreads().filter((q) => q.status === "queued").map((q) => queuedView(registry, q)), (q) => q.project)).get(project) ?? [],
        needs: () => needs ??= needsOf(c, detail),
      };
      return c;
    };
    for (const [pattern, page] of pages) {
      const m = pattern.exec(path);
      if (m !== null) return page(m, query, context);
    }
    return undefined;
  };
}
