/** Renders a thread's conversation region, and the frames its stream sends as the run grows. */
import { createHash } from "node:crypto";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Thread, ThreadId } from "../registry.ts";
import type { ClaudeConversation } from "../../claude-transcript.ts";
import type { PromptSenders } from "../inbox.ts";
import { agentView, type AgentView } from "../conversation-view.ts";
import type { Question } from "../questions.ts";
import { Html, html, ago } from "./view.ts";
import { itemsOf, modelOf, type Item } from "./items.ts";
import { blocks, blockView } from "./conversation.ts";

/**
 * The inside of the conversation region, which the page's stream sends again whenever it changed. `model` is the
 * model the next message goes to, or a Claude worker's.
 */
export function convo(t: Thread, view: AgentView | Error | null, items: readonly Item[], model: string | null, now: number): Html {
  const claude = view !== null && !(view instanceof Error) && view.kind === "claude" ? view.view : null;
  return html`
<p class="convo-meta"><code>${t.id}</code> · started ${ago(t.createdAt, now)}${claude !== null && " · Claude Code"}${model !== null && html` · ${model}`}</p>
${view === null ? html`<p class="empty">${t.status === "deleted" ? "The thread is deleted, so its conversation is gone." : "This thread has no agent conversation."}</p>`
  : view instanceof Error ? html`<p class="error">The conversation could not be read: ${view.message}</p>`
  : claude !== null && items.length === 0 ? html`<p class="empty">${claude.readAt === null ? "Claude's transcript has not been read yet. It is read while the pylon runs." : "Claude has not written a transcript yet."}</p>`
  : items.length === 0 ? html`<p class="empty">No messages yet.</p>`
  : html`${claude !== null && claude.dropped > 0 && html`<p class="note">${claude.dropped} older ${claude.dropped === 1 ? "entry is" : "entries are"} not kept.</p>`}${blocks(items).map((block) => blockView(block, now))}`}
`;
}

/**
 * One event of a thread page's stream: the conversation region's inside, or the new inside of each part that grew,
 * by its place among the region's `data-grow` elements. Each frame says which view the region then shows, and a
 * frame with only that comes when the view changed and the region did not.
 */
export type LiveFrame = { convo: string; shows: string } | { grow: [index: number, inside: string][]; shows: string } | { shows: string };

const digest = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 22);
const entryDigests = new WeakMap<readonly unknown[], string>();
const entriesDigest = (entries: readonly unknown[]) => entryDigests.get(entries) ?? entryDigests.set(entries, digest(JSON.stringify(entries))).get(entries)!;
/**
 * Which view a conversation region shows, from what `convo` renders of it, so a poll from a page whose stream shows
 * it can say so without rendering it. A watched Claude transcript keeps one entries array until an entry changes, and
 * so does a harness conversation's while pi-durable keeps it mounted, so each array is digested once.
 */
export function shownKey(read: AgentView, model: string | null): string {
  if (read.kind === "harness") {
    const { entries, docs } = read.view;
    return digest(JSON.stringify(["harness", entriesDigest(entries), docs["pi.live"] ?? null, docs["pi.inbox"] ?? null, model]));
  }
  const view = read.view;
  return digest(JSON.stringify([view.session, view.dropped, entriesDigest(view.entries), view.readAt === null, view.working, view.usageLimit, model]));
}

const grown = /<!--grow-->([\s\S]*?)<!--\/grow-->/g;

/** A render of a thread page's conversation region, with its growing parts apart, and the view it shows. */
interface LiveRender { region: string; shape: string; parts: readonly string[]; shows: string }

/**
 * Renders the conversation region once per view. Every watch of a conversation is handed the same view, so the
 * readers of one thread's stream that share this render each view once between them.
 */
function liveRender(t: Thread, claudeModel: string | null, questions: () => readonly Question[], senders: () => PromptSenders): (served: ConversationView | ClaudeConversation) => LiveRender {
  let last: { served: ConversationView | ClaudeConversation; render: LiveRender } | null = null;
  return (served) => {
    if (last?.served === served) return last.render;
    const view = agentView(served);
    const model = view.kind === "claude" ? claudeModel : modelOf(view.view);
    const region = convo(t, view, itemsOf(view, questions, t.id, senders), model, Date.now()).text;
    const render = { region, shape: region.replace(grown, "<!--grow-->"), parts: [...region.matchAll(grown)].map((m) => m[1]!), shows: shownKey(view, model) };
    last = { served, render };
    return render;
  };
}

/**
 * The frames of one reader of a thread page's stream. The conversation region goes whole whenever anything but
 * its growing parts changed, such as a new entry or a tool call that finished, and otherwise only the parts that
 * grew. Each frame is the change since the one this reader got last, so a reader that fell behind skips ahead.
 */
function readerFrames(render: (served: ConversationView | ClaudeConversation) => LiveRender): (served: ConversationView | ClaudeConversation) => LiveFrame | null {
  let shape: string | null = null;
  let parts: readonly string[] = [];
  let shown: string | null = null;
  return (served) => {
    const next = render(served);
    const grew = next.parts.flatMap((inside, i): [number, string][] => inside === parts[i] ? [] : [[i, inside]]);
    const changed = next.shape !== shape;
    shape = next.shape;
    parts = next.parts;
    const rekeyed = next.shows !== shown;
    shown = next.shows;
    if (changed) return { convo: next.region, shows: next.shows };
    if (grew.length > 0) return { grow: grew, shows: next.shows };
    return rekeyed ? { shows: next.shows } : null;
  };
}

/** The frames of a reader that renders for itself. */
export const liveFrames = (t: Thread, claudeModel: string | null = null, questions: () => readonly Question[] = () => [], senders: () => PromptSenders = () => () => null) =>
  readerFrames(liveRender(t, claudeModel, questions, senders));

/**
 * The renders of thread pages' streams, one per thread while any of its readers has framed a view, so a view renders
 * once however many pages stream it. A reader joins at its first frame, so one that never framed has nothing to
 * leave, and the last to leave drops its thread's render.
 */
export function liveStreams() {
  const shared = new Map<ThreadId, { render: ReturnType<typeof liveRender>; readers: number }>();
  return (t: Thread, claudeModel: string | null, questions: () => readonly Question[], senders: () => PromptSenders) => {
    let joined: { render: ReturnType<typeof liveRender>; readers: number } | null = null;
    const frames = readerFrames((served) => {
      if (joined === null) {
        joined = shared.get(t.id) ?? { render: liveRender(t, claudeModel, questions, senders), readers: 0 };
        joined.readers++;
        shared.set(t.id, joined);
      }
      return joined.render(served);
    });
    const leave = () => {
      if (joined === null) return;
      if (--joined.readers === 0 && shared.get(t.id) === joined) shared.delete(t.id);
      joined = null;
    };
    return { frames, leave };
  };
}
