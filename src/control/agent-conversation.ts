/**
 * A thread's conversation as the control plane's loops read it, whichever kind of agent the thread has: a Claude
 * worker's transcript as last read, or its harness conversation now. The review loop, the planner and the nudge each
 * take what they need from one read of it.
 */
import type { ConversationView } from "@earendil-works/pi-durable";
import { errorStop, type ClaudeEntry } from "../claude-transcript.ts";
import type { HarnessHost } from "../harness/host.ts";
import { promptSenders, type PromptSenders } from "./inbox.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import type { ThreadId } from "../ids.ts";

/** In order: a reply of the agent's, or a message to it and whether the person wrote it. */
export type Message = { role: "assistant"; text: string } | { role: "user"; person: boolean };
export interface Conversation {
  messages: Message[];
  /** The error the latest turn ended on because its model failed, or null when it did not. */
  failure: string | null;
}

/** A harness conversation's view now, from a watch opened for the read and stopped after it. */
export function harnessView(harness: Pick<HarnessHost, "watch">): (t: Pick<Thread, "id">) => Promise<ConversationView> {
  return async (t) => {
    const watch = await harness.watch(t.id);
    try {
      return watch.value;
    } finally {
      await watch.stop();
    }
  };
}

function harnessConversation(view: ConversationView): Conversation {
  const models = view.entries.flatMap((entry) => (entry.model ?? []).map((message) => ({ entry, message })));
  const last = models.findLast(({ message }) => message.role === "assistant")?.message;
  return {
    messages: models.flatMap(({ entry, message }): Message[] => message.role === "assistant" ? [{ role: "assistant", text: message.content.flatMap((c) => c.type === "text" ? [c.text] : []).join("") }]
      : message.role === "user" ? [{ role: "user", person: !entry.kind.startsWith("nexus.") }] : []),
    failure: last?.role === "assistant" && last.stopReason === "error" ? last.errorMessage ?? "no reason given" : null,
  };
}

function claudeConversation(registry: Registry, thread: ThreadId, entries: readonly ClaudeEntry[]): Conversation {
  // Only a prompt the transcript says the person typed needs the messages Nexus typed, which take a query.
  let sender: PromptSenders | undefined;
  return {
    messages: entries.flatMap((e): Message[] => e.kind === "reply" ? [{ role: "assistant", text: e.text }]
      : e.kind === "prompt" ? [{ role: "user", person: e.from === "person" && (sender ??= promptSenders(registry, thread))(e.text) === null }] : []),
    failure: errorStop(entries)?.text ?? null,
  };
}

/** Reads a thread's conversation. A bare thread has none. */
export function agentConversation(registry: Registry, view: (t: Pick<Thread, "id">) => Promise<ConversationView>): (t: Thread) => Promise<Conversation> {
  return async (t) => {
    switch (registry.agent(t).kind) {
      case "claude": return claudeConversation(registry, t.id, registry.claudeEntries(t.id));
      case "none": throw new Error(`thread ${t.id} has no agent, so it has no conversation`);
      case "harness": return harnessConversation(await view(t));
    }
  };
}

/** The agent's replies, oldest first. */
export const repliesOf = (c: Conversation): string[] => c.messages.flatMap((m) => m.role === "assistant" ? [m.text] : []);
/** Whether the person wrote to the thread after its first reply. */
export function personWrote(c: Conversation): boolean {
  const first = c.messages.findIndex((m) => m.role === "assistant");
  return first !== -1 && c.messages.slice(first).some((m) => m.role === "user" && m.person);
}

/**
 * When the newest turn of `t` that ended after `since` ended, or null when none has, whether a newer turn runs, and
 * whether a Claude worker replied since. A Claude turn that ends with a background shell or subagent running reports
 * heartbeats rather than its end, for up to hours, and stays `working`, so a Claude worker's turn also ends where its
 * transcript says, and a newer one runs once a prompt or a finished task follows that end there. `entries` is a
 * Claude worker's transcript, or null for a harness thread.
 */
export function heard(t: Pick<Thread, "lastReplyAt" | "working">, entries: readonly ClaudeEntry[] | null, since: number) {
  const ended = Math.max(t.lastReplyAt ?? -Infinity, ...(entries ?? []).flatMap((e) => e.kind === "turn" ? [e.at] : []));
  const running = t.working && (entries === null || entries.some((e) => (e.kind === "prompt" || e.kind === "task") && e.at > ended));
  return { ended: ended > since ? ended : null, running, replied: (entries ?? []).some((e) => e.kind === "reply" && e.at > since) };
}

/** What the review loop learns of an agent since `since` in one read: its replies and model failure, and `heard`'s turn facts. */
export type AgentState = ReturnType<typeof heard> & { replies: string[]; failure: string | null };

export function agentReader(registry: Registry, harness: Pick<HarnessHost, "watch">) {
  const read = agentConversation(registry, harnessView(harness));
  return {
    /**
     * A harness thread's conversation is opened only once a turn ended after `since`. Until then it can hold no answer,
     * and the state has no replies and no failure.
     */
    async state(t: Thread, since: number): Promise<AgentState> {
      if (registry.agent(t).kind === "claude") {
        const entries = registry.claudeEntries(t.id);
        const c = claudeConversation(registry, t.id, entries);
        return { ...heard(t, entries, since), replies: repliesOf(c), failure: c.failure };
      }
      const turn = heard(t, null, since);
      if (turn.ended === null) return { ...turn, replies: [], failure: null };
      const c = await read(t);
      return { ...turn, replies: repliesOf(c), failure: c.failure };
    },
    /** An agent's replies, oldest first. */
    replies: async (t: Thread): Promise<string[]> => repliesOf(await read(t)),
    personWrote: async (t: Thread): Promise<boolean> => personWrote(await read(t)),
  };
}
