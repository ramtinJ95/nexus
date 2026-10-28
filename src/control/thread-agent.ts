/**
 * What the control plane does with a thread's agent, whichever kind it is. The registry says which agent a thread
 * has (`Registry.agent`), and the API takes that kind's implementation here: the harness for a harness thread, and
 * claude-conversation.ts and the registry for a Claude worker. A bare thread has neither.
 *
 * The wire keeps each kind's own shapes: a harness conversation's view and its `/events` stream, and a Claude worker's
 * transcript and its `/claude/events` stream. Only the transcript carries a kind, which `agentView` reads.
 */
import type { ConversationView } from "@earendil-works/pi-durable";
import type { ClaudeConversation } from "../claude-transcript.ts";
import type { ClaudeConversations } from "./claude-conversation.ts";
import type { ThreadHarness } from "./api.ts";
import type { Registry, Thread } from "./registry.ts";

/** A thread's conversation, tagged with the kind of agent it is from. */
export type AgentView = { kind: "harness"; view: ConversationView } | { kind: "claude"; view: ClaudeConversation };

/** Tags a view as served, so the dashboard and the CLI tell the two apart without asking the thread again. */
export function agentView(view: ConversationView | ClaudeConversation): AgentView {
  return "kind" in view ? { kind: "claude", view } : { kind: "harness", view };
}

/** What a stream follows: a harness conversation's watch, or a Claude worker's. */
export interface Watch<V> {
  readonly value: V;
  start(listener: (view: V) => void | Promise<void>): void;
  stop(): Promise<unknown>;
  readonly closed: Promise<unknown>;
}

export interface Agent<V> {
  /** The conversation now. A Claude worker's is its transcript as last read, so it never reaches the pylon. */
  view(t: Thread): Promise<V>;
  watch(t: Thread): Promise<Watch<V>>;
  /** The snapshot ID of the latest turn, which the Changes view's turn base diffs against, or null before any. */
  latestTurn(t: Thread): Promise<string | null>;
  /** For a thread just deleted. */
  delete(t: Thread): Promise<void>;
}

export interface ThreadAgents { harness: Agent<ConversationView>; claude: Agent<ClaudeConversation> }

export function threadAgents(options: { registry: Registry; harness: ThreadHarness; claude: ClaudeConversations }): ThreadAgents {
  const { registry, harness, claude } = options;
  return {
    harness: {
      async view(t) {
        const watch = await harness.watch(t.id);
        try {
          return watch.value;
        } finally {
          await watch.stop();
        }
      },
      watch: (t) => harness.watch(t.id),
      latestTurn: (t) => harness.latestTurn(t.id),
      // Its run waits for a pylon until the thread is deleted, as the locator refuses a deleted thread's pylon.
      delete: (t) => harness.deleteThread({ threadId: t.id, pylonId: t.pylonId }),
    },
    claude: {
      view: async (t) => claude.view(t),
      watch: (t) => claude.watch(t),
      latestTurn: async (t) => registry.latestClaudeTurn(t.id),
      // A read that finds the thread deleted lets its reader go.
      delete: async (t) => { void claude.refresh(t); },
    },
  };
}
