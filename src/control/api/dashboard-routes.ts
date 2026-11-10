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
import type { ItemId, NodeName, ProjectId, TailnetNodeId, ThreadId } from "../../ids.ts";
import type { ThreadDetail, ThreadRow } from "../wire.ts";
import type { Thread } from "../thread-store.ts";
import type { AgentView, QueuedThread } from "../../contract/threads.ts";
import { queuedView } from "../queue.ts";
import { periods, periodStart, type Period } from "../usage.ts";
import { breakdowns } from "../../contract/usage.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import type { Features } from "../features.ts";
import type { Review } from "../review-model.ts";
import { ok } from "../dashboard/view.ts";
import type { ClusterView, Context, FoldView, Latest, NodeReading, Peek, ThreadView } from "../dashboard/context.ts";
import { needsOf } from "../work.ts";
import { asset } from "../dashboard/assets.ts";
import { findText, peekParam } from "../dashboard/contract.ts";
import { notFound } from "../dashboard/shell.ts";
import { home, foldPage } from "../dashboard/home.ts";
import { usagePage } from "../dashboard/usage-page.ts";
import { clusterPage, liveReading, recentMs, recordedReading } from "../dashboard/cluster-page.ts";
import { releaseView } from "../releases.ts";
import { nodePylons } from "../placement.ts";
import { itemView, threadStage } from "../pipeline.ts";
import { promptSenders } from "../inbox.ts";
import { claudeItems, conversationItems, type Item } from "../dashboard/items.ts";
import { threadRole } from "../work-model.ts";
import { landsOnItsOwn } from "../project.ts";
import { healthPage } from "../dashboard/health-page.ts";
import type { DoctorReport } from "../doctor-model.ts";
import { threadPage, queuedPage } from "../dashboard/thread-page.ts";
import { liveStreams, type ItemsOf } from "../dashboard/live-frames.ts";
import type { ApiKit, RouteEntry } from "./kit.ts";
import { anyAllowed, landing, refusal, refusalOf, type Role } from "./access.ts";
import { readHealth } from "./node-routes.ts";

type Caller = { caller: TailnetNodeId; roles: ReadonlySet<Role> };

/** The thread as the list would report it, from its detail, so its state agrees with the rest of the detail. */
const rowOf = (d: ThreadDetail): ThreadRow => ({ ...d.thread, attention: d.attention, desired: d.desired, pylon: d.pylon, pullRequestNumbers: d.pullRequests.map((pr) => pr.number) });

function latestOf(d: ThreadDetail, items: readonly Item[]): Latest {
  const reply = items.findLast((i) => i.kind === "agent" && i.text.trim() !== "");
  const asked = items.findLast((i) => i.kind === "user");
  return {
    reply: reply?.kind === "agent" ? { text: reply.text, at: d.thread.lastReplyAt } : null,
    asked: asked?.kind === "user" ? { text: asked.text, at: asked.at } : null,
  };
}

export function dashboardRoutes(kit: ApiKit, options: { features: Features; health(): DoctorReport | null }, nodeHealth: (name: NodeName) => Promise<NodeHealth>): readonly RouteEntry[] {
  const { registry, detail } = kit;
  const deploys = (r: Review) => options.features.reviews?.deploys(r) ?? false;
  const live = liveStreams();

  /** A failed read shows in the conversation, so the rest of the page still says what the pylon is doing. */
  async function transcript(t: Thread): Promise<AgentView | Error | null> {
    if (t.status === "deleted") return null;
    return kit.conversation(t).catch((err: unknown) => err as Error);
  }

  /** `now` is when the request came, read before any await, so the render tells time as of then. */
  const context = ({ caller, roles }: Caller, now = Date.now()): Context => {
    // The sidebar and the home table show the same threads.
    const rows = new Map<ThreadId, ThreadRow>();
    let reviews: readonly Review[] | undefined;
    let prs: ReadonlyMap<ThreadId, number[]> | undefined;
    const threads = registry.threads.threads();
    // registry.threads() is in the order registry.threads(project) is, so each project's keeps its order.
    const byProject: ReadonlyMap<string, readonly Thread[]> = Map.groupBy(threads, (t) => t.project);
    const queued: ReadonlyMap<string, readonly QueuedThread[]> = Map.groupBy(registry.queue.queuedThreads().filter((q) => q.status === "queued").map((q) => queuedView(registry, q)), (q) => q.project);
    const queuedIn = (project: string) => queued.get(project) ?? [];
    return {
      now, caller, deploys, landRefusal: options.features.reviews === null ? "no review loop" : refusal(roles, landing) === null ? null : "not a deployer",
      answerRefusal: (question) => refusalOf(roles, question),
      projects: registry.projects.projects(), nodes: registry.nodes.nodes(), image: registry.images.currentImage(),
      health: { states: registry.health.healthStates(), changes: registry.health.healthChanges() },
      threads, threadsIn: (project) => byProject.get(project) ?? [], queuedIn,
      needs: needsOf({ registry, now, threads: () => threads, queuedIn }, detail),
      reviews: () => reviews ??= registry.reviews.reviews(),
      row: (t) => rows.get(t.id) ?? rows.set(t.id, kit.row(t)).get(t.id)!,
      find: (t) => findText(t, (prs ??= registry.prWatches.prNumbers()).get(t.id)),
      thread: (id) => registry.threads.thread(id),
      title: (id) => registry.threads.thread(id)?.title ?? registry.queue.queuedThread(id)?.title ?? id,
      stage: (id) => threadStage(registry, id, now),
      review: (id) => registry.reviews.review(id),
    };
  };

  const offline = () => new Set(registry.nodes.nodes().filter((n) => n.state === "offline").map((n) => n.name));
  const itemsAt = (now: number) => registry.pipeline.items().map((i) => itemView(registry, i, now));
  const homePage = (c: Context, dialogs: Parameters<typeof home>[2], peek: Peek | null = null, card: string | null = null) =>
    ok(home(c, { offline: offline(), role: (t) => threadRole(registry, t), items: itemsAt(c.now) }, dialogs, peek, card));

  /** A conversation's items. Only a Claude worker's transcript reads the thread's questions and who typed its prompts. */
  const itemsOf = (thread: ThreadId): ItemsOf => (view) =>
    view.kind === "claude" ? claudeItems(view.view, registry.questions.questions(thread), thread, promptSenders(registry, thread)) : conversationItems(view.view, thread);
  const itemsFor = (thread: ThreadId, view: AgentView | Error | null): readonly Item[] => view === null || view instanceof Error ? [] : itemsOf(thread)(view);

  /**
   * The Cluster page with this node picked: what its probe reads of its host now, or why it could not. The API takes a
   * control report only from the control node, so the node that holds one is the control node.
   */
  const cluster = async (r: Caller, name: NodeName) => {
    const refused = refusal(r.roles, readHealth);
    const now = Date.now();
    const health = refused ?? await nodeHealth(name).catch((err: unknown) => err as Error);
    const c = context(r, now);
    const control = registry.releases.releaseReports().find((x) => x.role === "control")?.node;
    const reading = (node: NodeName): NodeReading => node === name ? health instanceof Error ? { kind: "failed", error: health.message } : liveReading(health)
      : refused !== null ? { kind: "refused" } : recordedReading(registry.nodeMetrics.nodeMetrics(node, c.now - recentMs, c.now, c.now), c.now);
    const view: ClusterView = {
      name, health, sample: registry.nodeMetrics.latestHealthSample(name),
      release: releaseView(registry, c.nodes.find((n) => n.name === control)?.tailnetNodeId, c.now),
      nodes: c.nodes.map((node) => ({ node, reading: reading(node.name), pylons: nodePylons(registry, node), cleanups: registry.questions.nodeQuestions(node.name) })),
      pylonThreads: new Map(registry.threads.pylonsOn(name).map((p) => {
        const t = registry.threads.thread(p.thread);
        return [p.pylonId, { thread: p.thread, builder: t !== undefined && threadRole(registry, t) === "builder" }];
      })),
    };
    return clusterPage(c, view);
  };

  /** The thread, queued thread or item the home page previews, with a thread's conversation as its page reads it. */
  async function peekOf(key: string | null, now: number): Promise<Peek | null> {
    if (key === null || key === "") return null;
    const thread = registry.threads.thread(key as ThreadId);
    if (thread !== undefined) {
      const view = await transcript(thread);
      const d = detail(registry.threads.thread(thread.id)!);
      return { kind: "thread", d, row: rowOf(d), latest: latestOf(d, itemsFor(thread.id, view)) };
    }
    const queued = registry.queue.queuedThread(key as ThreadId);
    if (queued !== undefined && queued.status === "queued") return { kind: "queued", q: queuedView(registry, queued) };
    const item = registry.pipeline.item(key as ItemId);
    return item === undefined ? null : { kind: "item", item: itemView(registry, item, now) };
  }

  return [
    ["GET", /^\/$/, anyAllowed, async (_, r) => {
      const now = Date.now();
      const peek = await peekOf(r.query.get(peekParam), now);
      return homePage(context(r, now), {}, peek, r.query.get("card"));
    }],
    ["GET", /^\/threads\/new$/, anyAllowed, (_, r) => homePage(context(r), { start: { project: r.query.get("project") } })],
    ["GET", /^\/projects\/new$/, anyAllowed, (_, r) => homePage(context(r), { addProject: true })],
    ["GET", /^\/usage$/, anyAllowed, (_, r) => {
      const c = context(r);
      const query = r.query.get("period") ?? "";
      const period = Object.hasOwn(periods, query) ? query as Period : "7d";
      const project = (r.query.get("project") || null) as ProjectId | null;
      return ok(usagePage(c, { period, project, report: registry.usage.usageReport({ since: periodStart(period, c.now), project, by: breakdowns }) }));
    }],
    // The pipeline's items show on the home page's work in flight now, and on their threads.
    ["GET", /^\/pipeline$/, anyAllowed, () => ({ status: 303, headers: { location: "/#in-flight" }, body: "" })],
    ["GET", /^\/cluster$/, anyAllowed, async (_, r) => {
      const first = registry.nodes.nodes()[0];
      if (first === undefined) return { ...ok(notFound(context(r), "No nodes yet.")), status: 404 };
      return ok(await cluster(r, first.name));
    }],
    ["GET", /^\/health$/, anyAllowed, (_, r) => ok(healthPage(context(r), options.health()))],
    ...(["closed", "quiet"] as const).map((kind): RouteEntry => ["GET", new RegExp(`^\\/threads\\/${kind}$`), anyAllowed, (_, r) => {
      const c = context(r);
      const id = r.query.get("project");
      const project = id === null ? null : registry.projects.project(id as ProjectId);
      if (project === undefined) return { ...ok(notFound(c, `No project ${id!}.`)), status: 404 };
      const page = Number(r.query.get("page"));
      const cancelled = kind === "quiet" ? [] : registry.queue.queuedThreads().filter((q) => q.status === "archived" || q.status === "deleted").toSorted((a, b) => b.createdAt - a.createdAt).map((q) => queuedView(registry, q));
      const fold: FoldView = { project: project?.id ?? null, projects: project === null ? registry.projects.projects() : [project], offline: offline(), cancelled };
      return ok(foldPage(c, kind, fold, Number.isInteger(page) && page > 0 ? page : 1, r.query.get("q")?.trim() ?? ""));
    }]),
    ["GET", /^\/threads\/([^/]+)$/, anyAllowed, async (m, r) => {
      const thread = registry.threads.thread(m[1]! as ThreadId);
      if (thread === undefined) {
        const queued = registry.queue.queuedThread(m[1]! as ThreadId);
        if (queued !== undefined && queued.status !== "started") return ok(queuedPage(context(r), queuedView(registry, queued)));
        return { ...ok(notFound(context(r), `No thread ${m[1]!}.`)), status: 404 };
      }
      // The reply known before this read is a safe watermark even if another turn ends during it. A Claude worker's
      // transcript is as of its last read that reached its end, which holds the reply only if it started after the
      // reply was recorded.
      const view = await transcript(thread);
      const repliedAt = view !== null && !(view instanceof Error) && view.kind === "claude" && (view.view.readAt ?? 0) < (thread.lastReplyAt ?? 0) ? null : thread.lastReplyAt;
      // After the read, so the facts are no older than the conversation, and a thread deleted meanwhile shows none.
      const d = detail(registry.threads.thread(thread.id)!);
      const t = d.thread;
      const shown = t.status === "deleted" ? null : view;
      const c = context(r);
      const page: ThreadView = {
        d, row: rowOf(d), node: registry.nodes.node(d.pylon.node)!, role: threadRole(registry, t), agent: registry.threads.agent(t),
        usage: registry.usage.usageReport({ since: null, thread: t.id }).total, view: shown, items: itemsFor(t.id, shown), renderedReplyAt: repliedAt,
        nudged: registry.nudges.nudge(t.id)?.state === "person", lands: landsOnItsOwn(registry.projects.project(t.project)?.autoReview),
        queuedAfter: registry.queue.queuedThread(t.id)?.after ?? null, item: itemsAt(c.now).find((i) => i.thread === t.id),
      };
      return ok(threadPage(c, page, r.query.has("streaming")));
    }],
    ["GET", /^\/threads\/([^/]+)\/stream$/, anyAllowed, ([, id], { caller }) => {
      const t = kit.thread(id!, { status: "kept" });
      const agent = kit.agentOf(t);
      const reader = live(t, registry.threads.claudeWorker(t.id)?.model ?? null, itemsOf(t.id));
      return { stream: (res) => kit.stream(res, caller, t, () => agent.watch(t), reader.frames, reader.leave) };
    }],
    ["GET", /^\/nodes\/([^/]+)$/, anyAllowed, async (m, r) => {
      const name = m[1]! as NodeName;
      if (registry.nodes.node(name) === undefined) return { ...ok(notFound(context(r), `No node ${name}.`)), status: 404 };
      return ok(await cluster(r, name));
    }],
    ["GET", /^\/assets\/([\w.-]+)$/, anyAllowed, (m, r) => {
      const served = asset(m[1]!);
      if (served === undefined) return { ...ok(notFound(context(r), `No asset ${m[1]!}.`)), status: 404 };
      // Pages link each asset with its hash, and a chunk's name has its hash, so neither URL ever changes and the
      // phone keeps it.
      const cache = served.version === null || r.query.get("v") === served.version ? "public, max-age=31536000, immutable" : "no-cache";
      return { status: 200, headers: { "content-type": served.type, "cache-control": cache, "x-content-type-options": "nosniff" }, body: served.body, encode: served.encode };
    }],
  ];
}
