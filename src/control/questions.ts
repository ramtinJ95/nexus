/**
 * A question a thread asks the person, answered on its card on the dashboard. Its thread's attention is `decision`
 * while it is open. Nothing asks one yet.
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
  answer: { option: string; by: TailnetNodeId; at: number } | null;
}

export type AnswerRefusal = "not a person" | "not a deployer";

/** Why the caller may not answer the question, or null when it may. */
export function answerRefusal(question: Pick<Question, "answerer">, caller: { person: boolean; deployer: boolean }): AnswerRefusal | null {
  if (!caller.person) return "not a person";
  return question.answerer === "deployer" && !caller.deployer ? "not a deployer" : null;
}
