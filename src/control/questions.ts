/**
 * A question the control plane asks the person about a thread or a node, answered on its card on the dashboard. A
 * thread's attention is `decision` while one of its questions is open. Each question is of a kind: the planning pass
 * asks a proposal one per item a planning thread proposes (planning.ts), a Claude worker's AskUserQuestion call is an
 * ask one while its pylon's hook reports that its dialog waits (the registry's asks), the review loop asks a holds one
 * about the holds at a review's head that the person may waive (review.ts), the judgment of a failed pylon asks a
 * judgment one when it leaves the failure to the person (judgment.ts), and the cleanup pass asks a cleanup one per node
 * about what it could delete (cleanup.ts).
 */
import { z } from "zod";
import type { AskAnswer } from "../../images/pylon/nexus-contract.ts";
import { textLimits, type ClaudeEntry } from "./claude-transcript.ts";
import type { NodeName, TailnetNodeId, ThreadId } from "../ids.ts";
import type { Hold } from "./holds.ts";
import type { ReservedCase } from "../contract/reserved.ts";
import type { Cleanup } from "./cleanup-model.ts";

interface Asked<K extends string> {
  kind: K;
  /** Chosen by the asker, so asking again with one ID asks nothing new. */
  id: string;
  text: string;
  /** Two or more distinct labels, one of which is the answer, or none for a Claude worker's ask, which is answered through `choices`. */
  options: readonly string[];
  /** A deployer question needs the right `nexus deploy` takes, since its answer may deploy. */
  answerer: "person" | "deployer";
  askedAt: number;
  /** An ask's answer holds a choice per asked question, and `option` sums them up in one line. */
  answer: { option: string; by: TailnetNodeId; at: number; choices?: readonly Choice[] } | null;
  /** Set once the question closed unanswered, as an archive closes an open failure question. It takes no answer after. */
  withdrawn?: { by: "archive"; at: number };
}

/** The merge policy reserves only what a holds question asks about. An older CLI's `nexus show` reads `reserved` on every question. */
interface Unreserved { reserved: null }

/** An item a planning thread proposed, which an answer to accept adds to the pipeline. */
export interface ProposalQuestion extends Asked<"proposal">, Unreserved { thread: ThreadId; proposal: Proposal }
/** A Claude worker's AskUserQuestion call. */
export interface ClaudeQuestion extends Asked<"ask">, Unreserved { thread: ThreadId; ask: ClaudeAsk }
/** The holds at the head of the thread's review that answering Land waives, as a Land press there does. */
export interface HoldsQuestion extends Asked<"holds"> {
  thread: ThreadId;
  holds: HeldQuestion;
  /** The merge policy's reserved case the holds are, or null for holds it does not reserve. */
  reserved: ReservedCase | null;
}
/** What to do about a failure of the thread's pylon, the thread.failed event `failure`. Archiving the thread withdraws it while it is open. */
export interface JudgmentQuestion extends Asked<"judgment">, Unreserved { thread: ThreadId; failure: number }
/** What a node could delete, which an answer to accept deletes. */
export interface CleanupQuestion extends Asked<"cleanup">, Unreserved { node: NodeName; cleanup: Cleanup }

/** A question about a thread, whose attention it holds while it is open. */
export type ThreadQuestion = ProposalQuestion | ClaudeQuestion | HoldsQuestion | JudgmentQuestion;
export type Question = ThreadQuestion | CleanupQuestion;
export type QuestionKind = Question["kind"];
export type QuestionOf<K extends QuestionKind> = Extract<Question, { kind: K }>;
/** A question as its asker hands it over, before any answer. */
export type Unanswered<Q extends Question = Question> = Q extends unknown ? Omit<Q, "answer"> : never;
/** Whether the question still waits for its answer. */
export const isOpen = (q: Pick<Question, "answer" | "withdrawn">) => q.answer === null && q.withdrawn === undefined;

/** The review a holds question is about, the head and base it was asked at, and the holds it names, each of which the person may waive. */
export interface HeldQuestion { review: string; head: string; base: string | null; holds: readonly Hold[] }
/**
 * The open question about the review's holds, asked at the round `at` when given. Land on it is taken only at the
 * review's latest round's head and base, since a change against another base is another change. The review loop asks
 * at most one per thread at a time.
 */
export const askingHolds = (questions: readonly Question[], review: string, at?: { head: string; base?: string | undefined }): HoldsQuestion | undefined =>
  questions.find((q): q is HoldsQuestion => q.kind === "holds" && isOpen(q) && q.holds.review === review
    && (at === undefined || (q.holds.head === at.head && q.holds.base === (at.base ?? null))));

/**
 * One item of a planning thread's block, as Question.proposal holds it. `block` is 12 hex characters, a hash of the
 * block's items, and `index` its place in the block, from 1. `after` holds keys of earlier items of the block, or
 * pipeline item IDs.
 */
export interface Proposal { block: string; index: number; key: string; title: string; brief: string; after: readonly string[] }

/** One question of a Claude worker's AskUserQuestion call, as the call's input holds it. */
export interface AskedQuestion { question: string; header: string; multiSelect: boolean; options: readonly { label: string; description: string; preview?: string }[] }
/** A Claude worker's AskUserQuestion call, which the pylon's PermissionRequest hook holds open until it is answered. */
export interface ClaudeAsk { session: string; toolUseId: string; questions: readonly AskedQuestion[] }
/** An ask whose dialog the pylon's hook reported waiting, and when the hook started waiting. */
export interface WaitingAsk { ask: ClaudeAsk; at: number }
/** The person's answer to one asked question: the options they picked, an answer of their own, and notes. */
export interface Choice { picked: readonly string[]; own?: string; notes?: string }

export type AnswerRefusal = "not a person" | "not a deployer";

/** Why the caller may not answer the question, or null when it may. */
export function answerRefusal(question: Pick<Question, "answerer">, caller: { person: boolean; deployer: boolean }): AnswerRefusal | null {
  if (!caller.person) return "not a person";
  return question.answerer === "deployer" && !caller.deployer ? "not a deployer" : null;
}

/** Claude's answer is keyed by the question's text and names labels, so one the transcript cut (textLimits.input) answers nothing. */
const whole = z.string().min(1).max(textLimits.input - 2);
const distinct = (values: readonly string[]) => new Set(values).size === values.length;
const askInput = z.object({
  questions: z.array(z.object({
    question: whole,
    header: whole,
    multiSelect: z.boolean().default(false),
    options: z.array(z.object({ label: whole, description: z.string(), preview: z.string().optional() })).min(1).refine((options) => distinct(options.map((o) => o.label))),
  })).min(1).refine((questions) => distinct(questions.map((q) => q.question))),
});

/** The questions of an AskUserQuestion call in a Claude worker's transcript, or null for any other entry or an input Claude's answer cannot key. */
export function askedIn(entry: ClaudeEntry): AskedQuestion[] | null {
  if (entry.kind !== "tool" || entry.name !== "AskUserQuestion") return null;
  const parsed = askInput.safeParse(entry.input);
  return parsed.success ? parsed.data.questions as AskedQuestion[] : null;
}

const reportedAsk = z.object({ session: z.string().min(1).max(200), toolUseId: z.string().min(1).max(200), at: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER), input: askInput });

/**
 * The asks in what `nexus-claude-hook asks` printed, a list of the pylon's ReportedAsk. One whose input Claude's
 * answer cannot key is left out, as is any item that is not an ask. An image from before the subcommand prints
 * nothing, which reports none. Throws for output that is not a list.
 */
export function reportedAsks(output: string): WaitingAsk[] {
  const reported = z.array(z.unknown()).parse(output.trim() === "" ? [] : JSON.parse(output));
  return reported.flatMap((item) => {
    const parsed = reportedAsk.safeParse(item);
    if (!parsed.success) return [];
    const { session, toolUseId, at, input } = parsed.data;
    return [{ ask: { session, toolUseId, questions: input.questions as AskedQuestion[] }, at }];
  });
}

/** The ID of the question an AskUserQuestion call is, so reading the call again asks nothing new. */
export const askQuestionId = (toolUseId: string) => `ask-${toolUseId}`;

/** The question an ask is. Each line of its text is one asked question. */
export function askRecord(thread: ThreadId, ask: ClaudeAsk, askedAt: number): Unanswered<ClaudeQuestion> {
  return {
    kind: "ask", id: askQuestionId(ask.toolUseId), thread, text: ask.questions.map((q) => `${q.header}: ${q.question}`).join("\n"), options: [], reserved: null,
    answerer: "person", askedAt, ask,
  };
}

const ownText = z.string().trim().min(1).max(4000);
const choiceSchema = z.strictObject({ picked: z.array(z.string()), own: ownText.optional(), notes: ownText.optional() });

/**
 * The person's choices for the ask, one per asked question in order, each picked option in the order the question
 * lists it. A question takes picked options or an answer of the person's own, and a single-select one only one of them.
 */
export function choicesSchema(ask: ClaudeAsk) {
  return z.array(choiceSchema).length(ask.questions.length, `the ask has ${ask.questions.length} questions, so it takes a choice for each`).superRefine((choices, ctx) => {
    choices.forEach((choice, i) => {
      const q = ask.questions[i]!;
      const labels = q.options.map((o) => o.label);
      const issue = (message: string) => ctx.addIssue({ code: "custom", path: [i], message: `${JSON.stringify(q.header)}: ${message}` });
      const unknown = choice.picked.find((label) => !labels.includes(label));
      if (unknown !== undefined) issue(`${JSON.stringify(unknown)} is not one of its options, which are ${labels.map((l) => JSON.stringify(l)).join(", ")}`);
      else if (!distinct(choice.picked)) issue("an option is picked twice");
      else if (choice.picked.length === 0 && choice.own === undefined) issue("pick an option or give an answer of your own");
      else if (!q.multiSelect && choice.picked.length + (choice.own === undefined ? 0 : 1) > 1) issue("it takes one answer, an option or your own");
    });
  }).transform((choices): Choice[] => choices.map(({ picked, own, notes }, i) => ({
    picked: ask.questions[i]!.options.map((o) => o.label).filter((label) => picked.includes(label)),
    ...own === undefined ? {} : { own }, ...notes === undefined ? {} : { notes },
  })));
}

/** What `nexus-claude-hook answer` hands Claude for the choices: each answer as the labels and the person's own, joined as Claude's terminal joins them, and the notes. */
export function askAnswer(ask: ClaudeAsk, choices: readonly Choice[]): AskAnswer {
  const asked = ask.questions.map((q, i) => ({ text: q.question, choice: choices[i]! }));
  return {
    session: ask.session,
    questions: asked.map((a) => a.text),
    toolUseId: ask.toolUseId,
    answers: Object.fromEntries(asked.map(({ text, choice }) => [text, [...choice.picked, ...choice.own === undefined ? [] : [choice.own]].join(", ")])),
    annotations: Object.fromEntries(asked.flatMap(({ text, choice }) => choice.notes === undefined ? [] : [[text, { notes: choice.notes }]])),
  };
}

/** The choices in one line, such as `Drink: Tea; Extras: Milk, Oat cream`, which an answer's `option` holds for readers that know only options. */
export function choicesSummary(ask: ClaudeAsk, choices: readonly Choice[]): string {
  const { answers } = askAnswer(ask, choices);
  return ask.questions.map((q) => `${q.header}: ${answers[q.question]}`).join("; ");
}
