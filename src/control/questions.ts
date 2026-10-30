/**
 * A question a thread asks the person, answered on its card on the dashboard. Its thread's attention is `decision`
 * while it is open. The planning pass asks one per item a planning thread proposes (planning.ts), and a Claude
 * worker's AskUserQuestion call is one while its pylon's hook reports that its dialog waits (the registry's asks).
 */
import { z } from "zod";
import type { AskAnswer } from "../../images/pylon/nexus-contract.ts";
import { textLimits, type ClaudeEntry } from "../claude-transcript.ts";
import type { TailnetNodeId } from "../ids.ts";
import type { ThreadId } from "./registry.ts";
import type { ReservedCase } from "./holds.ts";

export interface Question {
  /** Chosen by the asker, so asking again with one ID asks nothing new. */
  id: string;
  thread: ThreadId;
  text: string;
  /** Two or more distinct labels, one of which is the answer, or none for a Claude worker's ask, which is answered through `choices`. */
  options: readonly string[];
  /** The merge policy's reserved case the question is, or null for one it does not reserve. */
  reserved: ReservedCase | null;
  /** A deployer question needs the right `nexus deploy` takes, since its answer may deploy. */
  answerer: "person" | "deployer";
  askedAt: number;
  /** The item a planning thread proposed, which an answer to accept adds to the pipeline. */
  proposal?: Proposal;
  /** The Claude worker's AskUserQuestion call the question is. */
  ask?: ClaudeAsk;
  /** An ask's answer holds a choice per asked question, and `option` sums them up in one line. */
  answer: { option: string; by: TailnetNodeId; at: number; choices?: readonly Choice[] } | null;
}

/** One item of a planning thread's block. `after` holds keys of earlier items of the block, or pipeline item IDs. */
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
export function askRecord(thread: ThreadId, ask: ClaudeAsk, askedAt: number): Omit<Question, "answer"> {
  return {
    id: askQuestionId(ask.toolUseId), thread, text: ask.questions.map((q) => `${q.header}: ${q.question}`).join("\n"), options: [], reserved: null,
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
