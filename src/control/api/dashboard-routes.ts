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
import type { NodeName, ProjectId, TailnetNodeId, ThreadId } from "../../ids.ts";
import type { ThreadDetail, ThreadRow } from "../wire.ts";
import type { Thread } from "../thread-store.ts";
import type { AgentView } from "../../contract/threads.ts";
import { queuedView } from "../queue.ts";
import type { QueuedThread } from "../../contract/threads.ts";
import { periods, type Period } from "../usage.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import type { ReviewLoop } from "../review.ts";
import type { Review } from "../review-model.ts";
import { ok } from "../dashboard/view.ts";
import type { Context, FoldView, HomeView, Latest, Peek, ThreadView } from "../dashboard/context.ts";
import { needsOf, type InboxNeed } from "../work.ts";
import { assets } from "../dashboard/assets.ts";
import { notFound } from "../dashboard/shell.ts";
import { home, foldPage } from "../dashboard/home.ts";
import { usagePage } from "../dashboard/usage-page.ts";
import { clusterPage } from "../dashboard/cluster-page.ts";
import { itemView } from "../pipeline.ts";
import { promptSenders } from "../inbox.ts";
import { itemsOf, type Item } from "../dashboard/items.ts";
import { threadRole } from "../work-model.ts";
import { landsOnItsOwn } from "../project.ts";
import { healthPage } from "../dashboard/health-page.ts";
import type { DoctorReport } from "../doctor-model.ts";
import { threadPage, queuedPage } from "../dashboard/thread-page.ts";
import { liveStreams } from "../dashboard/live-frames.ts";
import type { ApiKit, RouteEntry } from "./kit.ts";
import { anyAllowed, landing, refusal, refusalOf, type Role } from "./access.ts";
import { readHealth } from "./node-routes.ts";

type Caller = { caller: TailnetNodeId; roles: ReadonlySet<Role> };

/** The thread as the list would report it, from its detail, so its state agrees with the rest of the detail. */
const rowOf = (d: ThreadDetail): ThreadRow => ({ ...d.thread, attention: d.attention, desired: d.desired, pylon: d.pylon });

function latestOf(d: ThreadDetail, items: readonly Item[]): Latest {
  const reply = items.findLast((i) => i.kind === "agent" && i.text.trim() !== "");
  const asked = items.findLast((i) => i.kind === "user");
  return {
    reply: reply?.kind === "agent" ? { text: reply.text, at: d.thread.lastReplyAt } : null,
    asked: asked?.kind === "user" ? { text: asked.text, at: asked.at } : null,
  };
}

export function dashboardRoutes(kit: ApiKit, options: { reviews?: ReviewLoop | null | undefined; health?: (() => DoctorReport | null) | undefined }, nodeHealth: (name: NodeName) => Promise<NodeHealth>): readonly RouteEntry[] {
  const { registry, detail } = kit;
  const deploys = (r: Review) => options.reviews?.deploys(r) ?? false;
  const live = liveStreams();

  /** A failed read shows in the conversation, so the rest of the page still says what the pylon is doing. */
  async function transcript(t: Thread): Promise<AgentView | Error | null> {
    if (t.status === "deleted") return null;
    return kit.conversation(t).catch((err: unknown) => err as Error);
  }

  const context = ({ caller, roles }: Caller): Context => {
    // The sidebar and the home table show the same threads.
    const rows = new Map<ThreadId, ThreadRow>();
    const row = (t: Thread) => rows.get(t.id) ?? rows.set(t.id, kit.row(t)).get(t.id)!;
    let needs: readonly InboxNeed[] | undefined;
    let threads: readonly Thread[] | undefined;
    let reviews: readonly Review[] | undefined;
    // registry.threads() is in the order registry.threads(project) is, so each project's keeps its order.
    let byProject: Map<string, Thread[]> | undefined;
    let queued: Map<string, QueuedThread[]> | undefined;
    const c: Context = {
      registry, row, deploys, now: Date.now(), caller, landRefusal: !options.reviews ? "no review loop" : refusal(roles, landing) === null ? null : "not a deployer",
      answerRefusal: (question) => refusalOf(roles, question),
      threads: () => threads ??= registry.threads(),
      threadsIn: (project) => (byProject ??= Map.groupBy(c.threads(), (t) => t.project)).get(project) ?? [],
      reviews: () => reviews ??= registry.reviews(),
      queuedIn: (project) => (queued ??= Map.groupBy(registry.queuedThreads().filter((q) => q.status === "queued").map((q) => queuedView(registry, q)), (q) => q.project)).get(project) ?? [],
      needs: () => needs ??= needsOf(c, detail),
    };
    return c;
  };

  const offline = () => new Set(registry.nodes().filter((n) => n.state === "offline").map((n) => n.name));
  const homeView = (): HomeView => ({ projects: registry.projects(), offline: offline(), role: (t) => threadRole(registry, t) });

  /** The conversation's items, which read the questions and the prompts' senders of a Claude worker's transcript. */
  const itemsFor = (d: ThreadDetail, view: AgentView | Error | null): readonly Item[] =>
    view === null || view instanceof Error ? [] : itemsOf(view, () => d.questions, d.thread.id, () => promptSenders(registry, d.thread.id));

  /** The Cluster page with this node picked: what its probe reads of its host now, or why it could not. */
  const cluster = async (c: Context, roles: ReadonlySet<Role>, name: NodeName) => {
    const refused = refusal(roles, readHealth);
    return clusterPage(c, name, refused ?? await nodeHealth(name).catch((err: unknown) => err as Error), refused === null);
  };

  /** The thread, queued thread or item the home page previews, with a thread's conversation as its page reads it. */
  async function peekOf(c: Context, key: string | null): Promise<Peek | null> {
    if (key === null || key === "") return null;
    const thread = registry.thread(key as ThreadId);
    if (thread !== undefined) {
      const view = await transcript(thread);
      const d = detail(registry.thread(thread.id)!);
      return { kind: "thread", d, row: rowOf(d), latest: latestOf(d, itemsFor(d, view)) };
    }
    const queued = registry.queuedThread(key as ThreadId);
    if (queued !== undefined && queued.status === "queued") return { kind: "queued", q: queuedView(registry, queued) };
    const item = registry.items().find((i) => i.id === key);
    return item === undefined ? null : { kind: "item", item: itemView(registry, item, c.now) };
  }

  return [
    ["GET", /^\/$/, anyAllowed, async (_, r) => {
      const c = context(r);
      const peek = await peekOf(c, r.query.get("peek"));
      return ok(home(c, homeView(), {}, peek, r.query.get("card")));
    }],
    ["GET", /^\/threads\/new$/, anyAllowed, (_, r) => ok(home(context(r), homeView(), { start: { project: r.query.get("project") } }))],
    ["GET", /^\/projects\/new$/, anyAllowed, (_, r) => ok(home(context(r), homeView(), { addProject: true }))],
    ["GET", /^\/usage$/, anyAllowed, (_, r) => {
      const period = r.query.get("period") ?? "";
      return ok(usagePage(context(r), Object.hasOwn(periods, period) ? period as Period : "7d", (r.query.get("project") || null) as ProjectId | null));
    }],
    // The pipeline's items show on the home page's work in flight now, and on their threads.
    ["GET", /^\/pipeline$/, anyAllowed, () => ({ status: 303, headers: { location: "/#in-flight" }, body: "" })],
    ["GET", /^\/cluster$/, anyAllowed, async (_, r) => {
      const c = context(r);
      const first = c.registry.nodes()[0];
      if (first === undefined) return { ...ok(notFound(c, "No nodes yet.")), status: 404 };
      return ok(await cluster(c, r.roles, first.name));
    }],
    ["GET", /^\/health$/, anyAllowed, (_, r) => ok(healthPage(context(r), options.health?.() ?? null))],
    ...(["closed", "quiet"] as const).map((kind): RouteEntry => ["GET", new RegExp(`^\\/threads\\/${kind}$`), anyAllowed, (_, r) => {
      const c = context(r);
      const id = r.query.get("project");
      const project = id === null ? null : registry.project(id as ProjectId);
      if (project === undefined) return { ...ok(notFound(c, `No project ${id!}.`)), status: 404 };
      const page = Number(r.query.get("page"));
      const cancelled = kind === "quiet" ? [] : registry.queuedThreads().filter((q) => q.status === "archived" || q.status === "deleted").toSorted((a, b) => b.createdAt - a.createdAt).map((q) => queuedView(registry, q));
      const fold: FoldView = { projects: project === null ? registry.projects() : [project], offline: offline(), cancelled };
      return ok(foldPage(c, kind, fold, Number.isInteger(page) && page > 0 ? page : 1));
    }]),
    ["GET", /^\/threads\/([^/]+)$/, anyAllowed, async (m, r) => {
      const thread = registry.thread(m[1]! as ThreadId);
      if (thread === undefined) {
        const queued = registry.queuedThread(m[1]! as ThreadId);
        if (queued !== undefined && queued.status !== "started") return ok(queuedPage(context(r), queuedView(registry, queued)));
        return { ...ok(notFound(context(r), `No thread ${m[1]!}.`)), status: 404 };
      }
      // The reply known before this read is a safe watermark even if another turn ends during it. A Claude worker's
      // transcript is as of its last read that reached its end, which holds the reply only if it started after the
      // reply was recorded.
      const view = await transcript(thread);
      const repliedAt = view !== null && !(view instanceof Error) && view.kind === "claude" && (view.view.readAt ?? 0) < (thread.lastReplyAt ?? 0) ? null : thread.lastReplyAt;
      // After the read, so the facts are no older than the conversation, and a thread deleted meanwhile shows none.
      const d = detail(registry.thread(thread.id)!);
      const t = d.thread;
      const shown = t.status === "deleted" ? null : view;
      const page: ThreadView = {
        d, row: rowOf(d), node: registry.node(d.pylon.node)!, role: threadRole(registry, t), agent: registry.agent(t),
        usage: registry.usageReport({ since: null, thread: t.id }).total, view: shown, items: itemsFor(d, shown), renderedReplyAt: repliedAt,
        nudged: registry.nudge(t.id)?.state === "person", lands: landsOnItsOwn(registry.project(t.project)?.autoReview),
      };
      return ok(threadPage(context(r), page, r.query.has("streaming")));
    }],
    ["GET", /^\/threads\/([^/]+)\/stream$/, anyAllowed, ([, id]) => {
      const t = kit.thread(id!, { status: "kept" });
      const agent = kit.agentOf(t);
      const reader = live(t, registry.claudeWorker(t.id)?.model ?? null, () => registry.questions(t.id), () => promptSenders(registry, t.id));
      return { stream: (res) => kit.stream(res, t, () => agent.watch(t), reader.frames, reader.leave) };
    }],
    ["GET", /^\/nodes\/([^/]+)$/, anyAllowed, async (m, r) => {
      const c = context(r);
      const name = m[1]! as NodeName;
      if (c.registry.node(name) === undefined) return { ...ok(notFound(c, `No node ${name}.`)), status: 404 };
      return ok(await cluster(c, r.roles, name));
    }],
    ["GET", /^\/assets\/([\w.-]+)$/, anyAllowed, (m, r) => {
      const asset = assets.get(m[1]!);
      if (asset === undefined) return { ...ok(notFound(context(r), `No asset ${m[1]!}.`)), status: 404 };
      // Pages link each asset with its hash, and a chunk's name has its hash, so neither URL ever changes and the
      // phone keeps it.
      const cache = asset.version === null || r.query.get("v") === asset.version ? "public, max-age=31536000, immutable" : "no-cache";
      return { status: 200, headers: { "content-type": asset.type, "cache-control": cache, "x-content-type-options": "nosniff" }, body: asset.body };
    }],
  ];
}
