/**
 * What the dashboard's pages and its client agree on. The templates and the client import it, so a rename here fails
 * the typecheck, the client's build or the dashboard's tests. The client bundles this file, so it imports only
 * types.
 */
import type { ActualState, ThreadStatus } from "../reconcile.ts";
import type { Attention } from "../attention.ts";
import type { EventKind } from "../events.ts";

/** The `data-action` of each button, which actions.js runs. */
export const actions = [
  "archive", "unarchive", "start-queued", "delete", "abort", "retry", "retry-pylon", "link-port", "unpublish",
  "cancel-review", "land", "review-again", "approve-item", "cancel-item", "auto-review", "answer",
  "open-session", "close-session", "show-session",
] as const;
export type Action = (typeof actions)[number];

/**
 * What a thread page's `#facts` says, which changes-tree.js reads to decide when to read the checkout's changes. `open`
 * is false for an archived or deleted thread, whose pylon stays paused.
 */
export interface Facts { pylon: ActualState; turn: boolean; agentAt: number; status: ThreadStatus; open: boolean }
export const factsData = (f: Facts) => ({ pylon: f.pylon, turn: String(f.turn), agentAt: String(f.agentAt), threadStatus: f.status, open: String(f.open) });
export const factsOf = (data: Readonly<Record<string, string | undefined>>): Facts => ({
  pylon: data.pylon as ActualState, turn: data.turn === "true", agentAt: Number(data.agentAt), status: data.threadStatus as ThreadStatus, open: data.open === "true",
});

/**
 * Each part of the conversation region that grows in place while the run streams: an element with the `data-grow`
 * attribute, whose inside the comments bound. Every string in a page is escaped, so no text can forge the comments.
 */
export const grow = { attr: "data-grow", slots: "[data-grow]", open: "<!--grow-->", close: "<!--/grow-->" } as const;
export const grown = new RegExp(`${grow.open}([\\s\\S]*?)${grow.close}`, "g");
export const growParts = (region: string) => ({ shape: region.replace(grown, grow.open), parts: [...region.matchAll(grown)].map((m) => m[1]!) });

/**
 * A region as the client compares it with what the server sent before: without the text of each run clock and each
 * time ago, which the client ticks, as view.ts `since` and `ago` write them. A browser serializes `data-ago` as
 * `data-ago=""`.
 */
export const unticked = (region: string) =>
  region.replace(/(<time data-since="\d+">)[^<]*/g, "$1").replace(/(<time [^>]*\bdata-ago(?:="")?>)[^<]*/g, "$1");

/** What a notice is for: an attention that waits on the person. A reply's notice opens its thread instead. */
export type NoticeAttention = Exclude<NonNullable<Attention>, "reply" | "working">;
/** The home page's hash that opens the card for what a thread waits on, which home.ts marks by `data-attention`. */
export const noticeHash = (thread: string, attention: NoticeAttention) => `#needs-you:${thread}:${attention}`;
export function noticeOf(hash: string): { thread: string; attention: string } | null {
  const m = /^#needs-you:([\w-]+):(\w+)$/.exec(hash);
  return m === null ? null : { thread: m[1]!, attention: m[2]! };
}

/** The pages whose `data-page` makes client.js load the modules no other page needs, as pages.js lists them. */
export const pages = ["home", "cluster"] as const;
export type Page = (typeof pages)[number];

/**
 * The icons a page's `#icons` template holds, which changes-tree.js clones into the trees it draws. shell.ts draws each
 * through view.ts `icon`, which types its name.
 */
export const clonedIcons = ["chevron", "folder"] as const;

/** The width at and under which a page lays out as a phone's, which style.css's phone rules also name. */
export const narrow = "(max-width: 760px)";

/** The `?peek=` of the home page, which previews a thread, a queued thread or an item by its ID. */
export const peekParam = "peek";
export const peekHref = (key: string) => `/?${peekParam}=${encodeURIComponent(key)}`;

/**
 * What a search for a thread matches: its title, project and ID, and each of its pull requests as `#88`. A thread row's
 * `data-find` holds it, and a fold page's `?q=` and the switcher match it. A query matches when its every word does.
 */
export const findText = (t: { id: string; title: string; project: string }, prs: readonly number[] = []) =>
  [t.title, t.project, t.id, ...prs.map((n) => `#${n}`)].join(" ").toLowerCase();
export const found = (text: string, query: string) => query.toLowerCase().split(/\s+/).every((word) => text.includes(word));

/**
 * The events that change a thread list row's attention, its reply or whether it works, and a check's change, which
 * rows.js follows.
 */
export const rowEvents = [
  "attention.changed", "thread.turn-ended", "session.turn-started", "session.turn-ended", "session.waiting", "session.ended", "health.changed",
] as const satisfies readonly EventKind[];

/** Each key the client keeps a reader's choice under, in localStorage, or for the tabs in sessionStorage. */
export const storageKeys = {
  theme: "nexus.theme",
  /** The dark theme the toggle goes back to. */
  darkTheme: "nexus.theme.dark",
  pane: "nexus.pane",
  /** "folded" while the reader keeps the sidebar folded away, above a phone's width. */
  side: "nexus.side",
  /** The sidebar's thread filter, kept for the tab. */
  filter: "nexus.filter",
  folded: "nexus.folded",
  flightView: "nexus.flight-view",
  base: "nexus.base",
  diffLayout: "nexus.diff-layout",
  graphRange: "nexus.node-graphs.range",
  hiddenGraphs: "nexus.node-graphs.hidden",
  tabs: (thread: string) => `nexus.tabs.${thread}` as const,
  /** The file tab open as the page went, and how far down its diff the reader was. */
  tabPlace: (thread: string) => `nexus.tab-place.${thread}` as const,
  review: (thread: string) => `nexus.review.${thread}` as const,
  draft: (thread: string) => `nexus.draft.${thread}` as const,
  /** The changed files the reader marked viewed. */
  viewed: (thread: string) => `nexus.viewed.${thread}` as const,
} as const;
type Keys = typeof storageKeys;
export type StorageKey = { [K in keyof Keys]: Keys[K] extends (thread: string) => infer R ? R : Keys[K] }[keyof Keys];

export interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
/**
 * Reads and writes of a browser's storage that a refusal, such as blocked site data or a full quota, turns into no
 * value and no write, so a page works without it. A null write removes the key.
 */
export function keeping(storage: () => Storage | null | undefined) {
  return {
    read(key: StorageKey): string | null {
      try { return storage()?.getItem(key) ?? null; } catch { return null; }
    },
    write(key: StorageKey, value: string | null): void {
      try {
        if (value === null) storage()?.removeItem(key);
        else storage()?.setItem(key, value);
      } catch {}
    },
  };
}
const browser = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
export const kept = keeping(() => browser.localStorage);
export const keptForTab = keeping(() => browser.sessionStorage);
