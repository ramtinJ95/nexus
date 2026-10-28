/**
 * A question a thread asks the person, answered on its card on the dashboard. Its thread's attention is `decision`
 * while it is open. The planning pass asks one per item a planning thread proposes (planning.ts).
 */
import type { TailnetNodeId } from "../protocol.ts";
import type { ThreadId } from "./registry.ts";
import type { ReservedCase } from "./review.ts";

export interface Question {
  /** Chosen by the asker, so asking again with one ID asks nothing new. */
  id: string;
  thread: ThreadId;
  text: string;
  /** Two or more distinct labels, one of which is the answer. */
  options: readonly string[];
  /** The merge policy's reserved case the question is, or null for one it does not reserve. */
  reserved: ReservedCase | null;
  /** A deployer question needs the right `nexus deploy` takes, since its answer may deploy. */
  answerer: "person" | "deployer";
  askedAt: number;
  /** The item a planning thread proposed, which an answer to accept adds to the pipeline. */
  proposal?: Proposal;
  answer: { option: string; by: TailnetNodeId; at: number } | null;
}

/** One item of a planning thread's block. `after` holds keys of earlier items of the block, or pipeline item IDs. */
export interface Proposal { block: string; index: number; key: string; title: string; brief: string; after: readonly string[] }

export type AnswerRefusal = "not a person" | "not a deployer";

/** Why the caller may not answer the question, or null when it may. */
export function answerRefusal(question: Pick<Question, "answerer">, caller: { person: boolean; deployer: boolean }): AnswerRefusal | null {
  if (!caller.person) return "not a person";
  return question.answerer === "deployer" && !caller.deployer ? "not a deployer" : null;
}
