import { CliError, UsageError } from "../transport.ts";
import { type Api, type Command, request, needsTerminal, typedYes } from "../kit.ts";
import { threadOf } from "../refs.ts";
import { questionText } from "../thread-text.ts";
import { threadRoutes } from "../../contract/threads.ts";
import { questionRoutes, type Question } from "../../contract/reviews.ts";

const isOpen = (q: Question) => q.answer === null && q.withdrawn === undefined;
const askedOf = (q: Question) => "thread" in q ? `thread ${q.thread}` : `node ${q.node}`;

/** A question by its ID, or else the open questions of the thread `given` names. */
async function questionsOf(api: Api, given: string): Promise<{ questions: Question[]; thread: string | null }> {
  try {
    return { questions: [await request(api, questionRoutes.show, { question: given })], thread: null };
  } catch (err) {
    if (!(err instanceof CliError) || err.kind !== "not-found") throw err;
  }
  const thread = await threadOf(api, given);
  try {
    return { questions: (await request(api, threadRoutes.show, { thread })).questions.filter(isOpen), thread };
  } catch (err) {
    if (err instanceof CliError && err.kind === "not-found") throw new CliError("not-found", `no question or thread ${given}`);
    throw err;
  }
}

/** An ask is answered with a choice per question it asks, which one option cannot give. */
const howToAnswer = (q: Question) => q.kind === "ask"
  ? `answer it in its pylon's terminal with \`nexus attach ${q.thread}\`, or on the dashboard`
  : `answer it with \`nexus answer ${q.id} <option>\``;

function listText(questions: readonly Question[], thread: string | null): string {
  if (questions.length === 0) return `${thread} asks no open question`;
  return questions.map((q) => `${questionText(q)}${isOpen(q) ? `\n  ${howToAnswer(q)}` : ""}`).join("\n");
}

function chosen(questions: readonly Question[], thread: string | null, option: string): Question {
  if (questions.length === 0) throw new CliError("not-found", `${thread} asks no open question`);
  if (questions.length > 1) throw new CliError("invalid", `${thread} asks ${questions.length} open questions, ${questions.map((q) => q.id).join(", ")}. Name the one to answer by its ID`);
  const q = questions[0]!;
  if (q.kind === "ask") throw new CliError("invalid", `question ${q.id} is a Claude worker's AskUserQuestion, which takes a choice for each question it asks, so ${howToAnswer(q)}`);
  if (!q.options.includes(option)) throw new UsageError(`${JSON.stringify(option)} is not an option of question ${q.id}, which are ${q.options.map((o) => JSON.stringify(o)).join(", ")}`);
  return q;
}

const terminalRefusal = "answer shows you the question and asks you to confirm your answer, and stdin or stderr is not a terminal. Run it in a terminal, or answer on the dashboard";

export const questionsCommands: Readonly<Record<string, Command>> = {
  answer: {
    help: [
      "  nexus answer <question|thread> [option]",
      "    the question, or the thread's open questions, and their options; with an option, answers it once you type yes",
    ],
    args: [1, 2],
    async run(api, [given, option], _v, _follow, { io }) {
      const terminal = { input: io.stdin, output: io.stderr };
      if (option !== undefined) needsTerminal(terminal, terminalRefusal);
      const { questions, thread } = await questionsOf(api, given!);
      if (option === undefined) return { json: questions, text: listText(questions, thread) };
      const q = chosen(questions, thread, option);
      const asked = `Answer question ${q.id} of ${askedOf(q)} with ${JSON.stringify(option)}:\n${q.text.split("\n").map((line) => `  ${line}\n`).join("")}Type yes to answer it: `;
      if (!await typedYes(terminal, asked)) throw new CliError("failed", `question ${q.id} is not answered, as you did not confirm`);
      const answered = await request(api, questionRoutes.answer, { question: q.id, body: { option } });
      return { json: answered, text: `Answered question ${q.id} ${JSON.stringify(answered.answer!.option)}` };
    },
  },
};
