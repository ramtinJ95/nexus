/** The view kit every dashboard page renders with: safe markup and the page's headers, icons, tones and badges. */
import { createHash } from "node:crypto";
import type { ActualState, DesiredPhase } from "../../reconcile.ts";
import type { HerdrStatus } from "../../protocol/observations.ts";
import type { ThreadRow } from "../wire.ts";
import { attentions, needsPerson } from "../attention.ts";
import type { Output, Thread } from "../thread-store.ts";
import type { ThreadId } from "../../ids.ts";
import { usageLimitText } from "../../claude-transcript.ts";
import { agoText, clock } from "./elapsed.ts";

export interface Page { status: number; headers: Record<string, string>; body: string }

/**
 * Sets the stored theme, or the device's light or dark, before the first paint, as theme.js does after it. A browser
 * that refuses the page its storage throws on reading it, and the device's theme stands.
 */
export const themeScript = `{ let theme = null; try { theme = localStorage.getItem("nexus.theme"); } catch {} document.documentElement.dataset.theme = theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }`;

const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src 'self'; script-src 'self' 'sha256-${createHash("sha256").update(themeScript).digest("base64")}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
export const ok = (html: Html): Page => ({ status: 200, headers: pageHeaders, body: html.text });

/** Markup that is safe to send. Only `html` makes one, and it escapes every string it interpolates. */
export class Html {
  readonly text: string;
  constructor(text: string) { this.text = text; }
}
export type Part = Html | string | number | false | null | undefined | readonly Part[];

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const render = (part: Part): string => part instanceof Html ? part.text
  : Array.isArray(part) ? part.map(render).join("")
  : part === false || part === null || part === undefined ? ""
  : String(part).replace(/[&<>"']/g, (c) => escapes[c]!);

export function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  return new Html(strings.reduce((out, s, i) => out + render(parts[i - 1]) + s));
}

/** The colour of a status dot. `work` is an agent mid-turn, `busy` a pylon changing phase. */
export type Tone = "ok" | "work" | "busy" | "idle" | "bad" | "muted";
export const actualBadge: Record<ActualState, [label: string, tone: Tone]> = {
  running: ["running", "ok"], spawning: ["spawning", "busy"], pausing: ["pausing", "busy"], deleting: ["deleting", "busy"],
  paused: ["paused", "idle"], absent: ["not on its node", "muted"], failed: ["failed", "bad"], unknown: ["unknown", "muted"],
};
export const desiredTone: Record<DesiredPhase, Tone> = { running: "ok", reading: "work", paused: "idle", deleted: "muted" };
export const sessionTone: Record<HerdrStatus, Tone> = { working: "work", idle: "idle", blocked: "bad", done: "ok", unknown: "muted" };
export const outputLabel: Record<Output["kind"], string> = { branch: "branch", diff: "diff", preview: "preview", file: "file", "pull-request": "pull request" };

/** A dot alone carries its meaning in its accessible name. One beside its label is decoration. */
export const dot = (tone: Tone, label?: string) => label === undefined
  ? html`<span class="dot dot-${tone}" aria-hidden="true"></span>`
  : html`<span class="dot dot-${tone}" role="img" aria-label="${label}" title="${label}"></span>`;
export const state = (label: string, tone: Tone) => html`<span class="state">${dot(tone)}${label}</span>`;

/** Line icons on a 16-unit grid, drawn in the text's colour. */
const iconPaths = {
  folder: "M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z",
  branch: "M5 2.5v11M5 13.5a1.5 1.5 0 1 0 0-.01M11 2.5a1.5 1.5 0 1 0 0 .01M11 4v1.5a3 3 0 0 1-3 3H5",
  chevron: "M6 4l4 4-4 4",
  chat: "M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5z",
  changes: "M8 2.5v6M5 5.5h6M5 12.5h6",
  globe: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12",
  server: "M3 3h10v4H3zM3 9h10v4H3zM5.5 5h.01M5.5 11h.01",
  plus: "M8 3v10M3 8h10",
  palette: "M8 2.5a5.5 5.5 0 0 0 0 11c.8 0 1.2-.5 1.2-1.1 0-.7-.5-1-.5-1.6 0-.6.5-1 1.1-1h1.4a2.3 2.3 0 0 0 2.3-2.3C13.5 4.6 11.1 2.5 8 2.5zM5 8h.01M6.5 5.2h.01M9.7 5.2h.01",
  contrast: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM8 2.5v11",
  up: "M8 13V3M4 7l4-4 4 4",
  chart: "M3 13.5h10M4.5 11V8M8 11V3.5M11.5 11V6",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01",
  terminal: "M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5",
  check: "M3.5 8.5l3 3 6-7",
  cross: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  dash: "M5 8h6",
  inbox: "M2.5 9.5h3l1 1.5h3l1-1.5h3M2.5 9.5 4.3 4.2a1 1 0 0 1 .9-.7h5.6a1 1 0 0 1 .9.7l1.8 5.3v2.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
} as const;
type IconName = keyof typeof iconPaths;
export const icon = (name: IconName) => html`<svg class="i i-${name}" viewBox="0 0 16 16" aria-hidden="true"><path d="${iconPaths[name]}"/></svg>`;
/** The icons client.js clones from the page's `#icons`, for the folders of the changed files' tree. */
export const clonedIcons = ["chevron", "folder"] as const satisfies readonly IconName[];
/** Every page's way to the sidebar, and on a phone, where the sidebar is a drawer, to what waits on the person. */
export const menu = html`<button type="button" class="icon-btn menu" data-open="side" aria-label="Threads">☰</button><a class="icon-btn phone-only" href="/#needs-you" aria-label="Needs you" title="Needs you">${icon("inbox")}</a>`;
/** Text a screen reader says that the page shows another way, such as with an icon or a bubble's side. */
export const unseen = (text: string) => html`<span class="vh">${text}</span>`;

/** What stopped a thread on its usage limit, and when it resets. */
export const limitText = (t: Pick<Thread, "usageLimit">, now: number) => usageLimitText(t.usageLimit ?? { resetsAt: null }, now);

/** What a thread is doing, most urgent first: the agent mid-turn hides a running pylon, never a failed one. */
export function threadState(t: ThreadRow, now: number): [label: string, tone: Tone] {
  const { attention, pylon } = t;
  if (attention === "limited") return [limitText(t, now), attentions.limited.tone];
  if (attention === "waiting") return [t.sessionWaitingMessage ?? attentions.waiting.label, attentions.waiting.tone];
  if (attention !== null) return [attentions[attention].label, attentions[attention].tone];
  if (t.status === "archived" || t.status === "deleted") return [t.status, "muted"];
  return actualBadge[pylon.actualState];
}

/** The open thread's row never dims, nor a closed thread's, which its fold already sets apart. */
export const dims = (t: ThreadRow, active?: ThreadId) =>
  t.id !== active && (t.status === "active" || t.status === "idle") && !needsPerson(t.attention);

/** "5 min ago", which client.js ticks with the same format. */
export function ago(at: number, now: number): Html {
  if (at === 0) return html`never`;
  const iso = new Date(at).toISOString();
  return html`<time datetime="${iso}" title="${iso}" data-ago>${agoText(at, now)}</time>`;
}

/** How long a thread's running turn has worked, which client.js ticks, or null when no turn runs. */
export function workingFor(t: Thread, now: number): Html | null {
  if (!t.working) return null;
  return t.workingSince === undefined ? html`working` : html`working <time data-since="${t.workingSince}">${clock(now - t.workingSince)}</time>`;
}

export const short = (commit: string) => html`<code title="${commit}">${commit.slice(0, 12)}</code>`;

/**
 * The inside of a `data-grow` element, which grows in place while the run streams. Every string in a page is
 * escaped, so no text can forge the comments that bound it.
 */
export const grows = (inside: Part) => html`<!--grow-->${inside}<!--/grow-->`;
