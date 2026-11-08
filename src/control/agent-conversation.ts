/**
 * A thread's conversation as the control plane's loops read it, whichever kind of agent the thread has: a Claude
 * worker's transcript as last read, or its harness conversation now. The review loop, the planner and the nudge each
 * take what they need from one read of it.
 */
import type { ConversationView } from "@earendil-works/pi-durable";
import { errorStop, type ClaudeEntry } from "./claude-transcript.ts";
import type { HarnessHost } from "./harness/host.ts";
import { busyOf } from "./conversation-view.ts";
import { promptSenders, type PromptSenders } from "./inbox.ts";
import type { Registry } from "./registry.ts";
import type { Thread, ThreadAgent } from "./thread-store.ts";
import type { ThreadId } from "../ids.ts";

type AgentConversationRegistry = Pick<Registry, "agent" | "claudeEntries" | "claudeWorker" | "claudeMessage" | "claudeMessageSenders" | "node" | "pylon" | "recordActivity" | "sealedBoot" | "setClaudeMessage">;

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

function claudeConversation(registry: AgentConversationRegistry, thread: ThreadId, entries: readonly ClaudeEntry[]): Conversation {
  // Only a prompt the transcript says the person typed needs the messages Nexus typed, which take a query.
  let sender: PromptSenders | undefined;
  return {
    messages: entries.flatMap((e): Message[] => e.kind === "reply" ? [{ role: "assistant", text: e.text }]
      : e.kind === "prompt" ? [{ role: "user", person: e.from === "person" && (sender ??= promptSenders(registry, thread))(e.text) === null }] : []),
    failure: errorStop(entries)?.text ?? null,
  };
}

export const repliesOf = (c: Conversation): string[] => c.messages.flatMap((m) => m.role === "assistant" ? [m.text] : []);
/** Whether the person wrote to the thread after its first reply. */
export function personWrote(c: Conversation): boolean {
  const first = c.messages.findIndex((m) => m.role === "assistant");
  return first !== -1 && c.messages.slice(first).some((m) => m.role === "user" && m.person);
}

/**
 * The turn facts of `t` since `since`: `ended`, when its newest turn that ended after `since` ended, or null when none
 * has; `over`, that end once no newer turn runs, or null; and `mayAnswer`, whether it ended a turn or a Claude worker
 * replied since, the only time its replies can hold an answer. A Claude turn that ends with a background shell or
 * subagent running reports heartbeats rather than its end, for up to hours, and stays `working`, so a Claude worker's
 * turn also ends where its transcript says, and a newer one runs once a prompt or a finished task follows that end
 * there. `entries` is a Claude worker's transcript, or null for a harness thread.
 */
export function heard(t: Pick<Thread, "lastReplyAt" | "working">, entries: readonly ClaudeEntry[] | null, since: number) {
  const newest = Math.max(t.lastReplyAt ?? -Infinity, ...(entries ?? []).flatMap((e) => e.kind === "turn" ? [e.at] : []));
  const running = t.working && (entries === null || entries.some((e) => (e.kind === "prompt" || e.kind === "task") && e.at > newest));
  const ended = newest > since ? newest : null;
  return { ended, over: running ? null : ended, mayAnswer: ended !== null || (entries ?? []).some((e) => e.kind === "reply" && e.at > since) };
}

/** What the review loop learns of an agent since `since` in one read: its replies and model failure, and `heard`'s turn facts. */
export type AgentState = ReturnType<typeof heard> & { replies: string[]; failure: string | null };

/** What the control plane's loops read of a thread's agent, one implementation per kind. */
export interface AgentRead {
  /** A bare thread has none. */
  conversation(t: Thread): Promise<Conversation>;
  state(t: Thread, since: number): Promise<AgentState>;
  /** The first message the agent got, which is its brief, or null when it has none. */
  brief(t: Thread): Promise<string | null>;
  /** Whether a turn the control plane runs is running or queued, which a deploy's drain waits out. */
  busy(t: Pick<Thread, "id">): Promise<boolean>;
}

export function agentReads(registry: AgentConversationRegistry, harness: Pick<HarnessHost, "watch">): Record<ThreadAgent["kind"], AgentRead> {
  const view = harnessView(harness);
  /**
   * A conversation in the control plane is opened only once a turn ended after `since`. Until then it can hold no
   * answer, and the state has no replies and no failure.
   */
  const stateOf = (conversation: AgentRead["conversation"]): AgentRead["state"] => async (t, since) => {
    const turn = heard(t, null, since);
    if (turn.ended === null) return { ...turn, replies: [], failure: null };
    const c = await conversation(t);
    return { ...turn, replies: repliesOf(c), failure: c.failure };
  };
  const harnessRead = async (t: Thread) => harnessConversation(await view(t));
  const noneRead = async (t: Thread): Promise<never> => { throw new Error(`thread ${t.id} has no agent, so it has no conversation`); };
  return {
    harness: {
      conversation: harnessRead,
      state: stateOf(harnessRead),
      async brief(t) {
        const first = (await view(t)).entries.flatMap((entry) => entry.model ?? []).find((message) => message.role === "user");
        if (first === undefined) return null;
        return typeof first.content === "string" ? first.content : first.content.flatMap((c) => c.type === "text" ? [c.text] : []).join("");
      },
      async busy(t) {
        const { working, queued } = busyOf(await view(t));
        return working || queued > 0;
      },
    },
    claude: {
      conversation: async (t) => claudeConversation(registry, t.id, registry.claudeEntries(t.id)),
      async state(t, since) {
        const entries = registry.claudeEntries(t.id);
        const c = claudeConversation(registry, t.id, entries);
        return { ...heard(t, entries, since), replies: repliesOf(c), failure: c.failure };
      },
      brief: async (t) => registry.claudeWorker(t.id)!.prompt,
      // Its turns run in its pylon, which a deploy of the control plane leaves alone.
      busy: async () => false,
    },
    none: { conversation: noneRead, state: stateOf(noneRead), brief: async () => null, busy: async () => false },
  };
}

export function agentReader(registry: AgentConversationRegistry, harness: Pick<HarnessHost, "watch">) {
  const reads = agentReads(registry, harness);
  const of = (t: Thread) => reads[registry.agent(t).kind];
  return {
    conversation: (t: Thread) => of(t).conversation(t),
    state: (t: Thread, since: number) => of(t).state(t, since),
    brief: (t: Thread) => of(t).brief(t),
    replies: async (t: Thread): Promise<string[]> => repliesOf(await of(t).conversation(t)),
    personWrote: async (t: Thread): Promise<boolean> => personWrote(await of(t).conversation(t)),
  };
}
