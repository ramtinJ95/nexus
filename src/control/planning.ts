/**
 * Planning threads: a Nexus agent thread the person opens to plan. It has no tool that reaches another thread or an
 * item. When it has a plan it ends a turn with a `nexus-plan` block of proposed items that echoes its thread's token,
 * and the control plane asks the person one question per proposal. Only the person answers, and an accepted proposal
 * becomes a pipeline item, added by the person, as `nexus item add` adds one. So nothing a planning thread writes starts
 * a builder on its own, whatever its project's pipeline setting.
 *
 * Each proposal's question ID is made from its thread, a hash of its block and its place in the block, and asking a
 * question with an ID that exists asks nothing. So a pass reads every reply of a thread whose turn ended since its last
 * read, and a block read twice, or a pass cut short by a restart, makes each card once.
 *
 * The thread learns of the format only from its messages: the control plane puts the guide, with the token, in front
 * of the thread's first message, and what the person answered since in front of each later one. What each message got
 * is stored under its request ID before it is sent, so a resend of the ID sends the same text.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { mint, planningPrefix, tokenBlocks } from "../agent-protocol.ts";
import { singleFlight } from "../single-flight.ts";
import { HttpError } from "./http-error.ts";
import type { Pipeline } from "./pipeline.ts";
import type { ItemId, ItemRecord } from "./pipeline-store.ts";
import type { Proposal, Question } from "./questions.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import type { ThreadId } from "../ids.ts";

export const planFence = "nexus-plan";
export const acceptOption = "accept";
export const rejectOption = "reject";
const itemIdPattern = /^it-[0-9a-f]{12}$/;

const blockSchema = z.object({
  token: z.string(),
  items: z.array(z.object({
    key: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(200),
    brief: z.string().trim().min(1).max(16_384),
    after: z.array(z.string().trim().min(1)).max(32).default([]),
  })).min(1).max(20),
}).superRefine(({ items }, ctx) => {
  items.forEach((item, i) => {
    const earlier = items.slice(0, i).map((e) => e.key);
    if (earlier.includes(item.key)) ctx.addIssue({ code: "custom", message: `key ${item.key} is used twice` });
    for (const ref of item.after) {
      if (!earlier.includes(ref) && !itemIdPattern.test(ref)) ctx.addIssue({ code: "custom", message: `${item.key} waits on ${ref}, which is neither an earlier item of the block nor a pipeline item's ID` });
    }
  });
});

/** Every block in the replies that echoes the token and reads as a plan, oldest first, each as its proposals. */
export function planBlocks(replies: readonly string[], token: string): Proposal[][] {
  return tokenBlocks(replies, planFence, blockSchema, token).map(({ items }) => {
    const block = createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 12);
    return items.map((item, i) => ({ block, index: i + 1, ...item }));
  });
}

/** The index is padded, so the cards of one block, asked together, list in the block's order. */
export const proposalId = (thread: ThreadId, p: Pick<Proposal, "block" | "index">) => `plan:${thread}:${p.block}:${String(p.index).padStart(2, "0")}`;
/** The item an accepted proposal became. Made from the question, so the thread can be told it without a stored link. */
export const proposalItem = (question: string) => `it-${createHash("sha256").update(question).digest("hex").slice(0, 12)}` as ItemId;

export function proposalQuestion(t: Thread, p: Proposal, siblings: readonly Proposal[], askedAt: number): Omit<Question, "answer"> {
  const waits = p.after.map((ref) => {
    const sibling = siblings.find((s) => s.key === ref && s.index < p.index);
    return sibling === undefined ? `pipeline item ${ref}` : `"${sibling.title}", proposed above`;
  });
  return {
    id: proposalId(t.id, p), thread: t.id, reserved: null, answerer: "person", askedAt, proposal: p, options: [acceptOption, rejectOption],
    text: `The planning thread proposes a pipeline item: ${p.title}

${p.brief}

${waits.length === 0 ? "It waits on no other item." : `It waits on ${waits.join(", ")}.`} Accept adds it to project ${t.project}'s pipeline as yours, as nexus item add does. Reject tells the planning thread in your next message to it.`,
  };
}

function guide(token: string): string {
  return `${planningPrefix}
This is a planning thread. You plan the work and the person decides it: you have no tool that starts, messages or waits on another thread or adds work, and nothing you write starts a builder. When you have a plan, end your turn with exactly one block like this, with JSON in it:
\`\`\`${planFence}
{"token": "${token}", "items": [{"key": "a", "title": "one line", "brief": "the builder's whole first message", "after": []}]}
\`\`\`
Each item becomes a card the person accepts or rejects. An accepted item is queued as a builder thread whose first message is its brief, and the builder knows nothing else of this conversation, so write each brief as a complete instruction. "after" lists the keys of earlier items in the same block, or the IDs of pipeline items (it-...), whose pull requests must merge first. Your next message from the person starts with what they accepted, with each new item's ID, and what they rejected. Revise if they ask you to, and propose only new or changed items in a later block.
The person's message follows.`;
}

function answers(questions: readonly Question[]): string {
  return `${planningPrefix}
The person answered your proposals:
${questions.map((q) => q.answer!.option === acceptOption ? `- accepted "${q.proposal!.title}" (key ${q.proposal!.key}), now pipeline item ${proposalItem(q.id)}` : `- rejected "${q.proposal!.title}" (key ${q.proposal!.key})`).join("\n")}
The person's message follows.`;
}

export type Planning = ReturnType<typeof planning>;

export function planning(options: { registry: Registry; pipeline: Pick<Pipeline, "add"> | null; replies(t: Thread): Promise<string[]>; log?: (message: string) => void; now?: () => number }) {
  const { registry, replies, log = () => {} } = options;
  const now = options.now ?? Date.now;

  async function pass() {
    for (const { thread } of registry.planningThreads()) {
      const t = registry.thread(thread);
      const read = registry.planning(thread)!.read;
      if (t === undefined || t.status === "archived" || t.status === "deleted" || t.working || t.lastReplyAt === null || t.lastReplyAt <= read) continue;
      const through = t.lastReplyAt;
      try {
        for (const block of planBlocks(await replies(t), registry.planning(thread)!.token)) {
          const at = now();
          for (const p of block) registry.askQuestion(proposalQuestion(t, p, block, at));
        }
        registry.savePlanning({ ...registry.planning(thread)!, read: through });
      } catch (err) {
        log(`planning thread ${thread}: its replies were not read: ${(err as Error).message}`);
      }
    }
  }

  /** What an accepted proposal waits on, as item IDs: items as named, and earlier proposals of its block by the items they became. */
  function resolveAfter(q: Question & { proposal: Proposal }): ItemId[] {
    const siblings = registry.questions(q.thread).filter((s) => s.proposal?.block === q.proposal.block && s.proposal.index < q.proposal.index);
    return q.proposal.after.map((ref) => {
      const sibling = siblings.find((s) => s.proposal!.key === ref);
      if (sibling === undefined) return ref as ItemId;
      if (sibling.answer === null) throw new HttpError(409, `"${q.proposal.title}" waits on "${sibling.proposal!.title}", which is not answered yet. Accept that one first`);
      if (sibling.answer.option !== acceptOption) throw new HttpError(409, `"${q.proposal.title}" waits on "${sibling.proposal!.title}", which was rejected, so it cannot be added. Reject it too, and tell the planning thread what to change`);
      return proposalItem(sibling.id);
    });
  }

  const passes = singleFlight(pass);
  return {
    /** Marks a thread as planning, once. A repeat keeps its token. */
    begin(t: Thread): void {
      if (registry.agent(t).kind !== "harness") throw new HttpError(400, "a planning thread is a Nexus agent thread, not a Claude worker");
      if (registry.planning(t.id) === null) registry.savePlanning({ thread: t.id, token: mint(t.id), read: 0, sent: [] });
    },
    /**
     * The text to send to `t` under `requestId`: the guide before a planning thread's first message the harness took,
     * and the answers no taken message told of. A resend of the ID gets the same text.
     */
    compose(t: Thread, requestId: string, text: string): string {
      const record = registry.planning(t.id);
      if (record === null) return text;
      let entry = record.sent.find((s) => s.requestId === requestId);
      if (entry === undefined) {
        const delivered = record.sent.filter((s) => s.delivered);
        const told = new Set(delivered.flatMap((s) => s.told));
        entry = { requestId, guide: delivered.length === 0, told: registry.questions(t.id).filter((q) => q.proposal !== undefined && q.answer !== null && !told.has(q.id)).map((q) => q.id), delivered: false };
        registry.savePlanning({ ...record, sent: [...record.sent, entry] });
      }
      const tells = entry.told.map((id) => registry.question(id)!);
      return [...entry.guide ? [guide(record.token)] : [], ...tells.length === 0 ? [] : [answers(tells)], text].join("\n\n");
    },
    /** The harness took the message composed under `requestId`. */
    sent(t: Thread, requestId: string): void {
      const record = registry.planning(t.id);
      if (record === null) return;
      registry.savePlanning({ ...record, sent: record.sent.map((s) => s.requestId === requestId ? { ...s, delivered: true } : s) });
    },
    /**
     * Runs in the transaction that records an answer, so an accepted proposal and its item are stored together or not
     * at all, and a refusal leaves the question open.
     */
    answered(q: Question): ItemRecord | null {
      if (q.proposal === undefined || q.answer?.option !== acceptOption) return null;
      if (options.pipeline === null) throw new HttpError(409, "pipeline items need the control plane's GitHub token (github.tokenFile), which is not configured");
      const t = registry.thread(q.thread)!;
      return options.pipeline.add({ project: t.project, title: q.proposal.title }, q.proposal.brief, resolveAfter(q as Question & { proposal: Proposal }), q.answer.by, proposalItem(q.id));
    },
    poll: passes.rerun,
    close: passes.settled,
  };
}
